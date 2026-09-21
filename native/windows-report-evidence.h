// Shared report protocol's Windows storage boundary. No decoded strings cross
// this API. Read leases pin every ancestor and deny file write/delete sharing.
constexpr size_t ReportMaxBytes = 2 * 1024 * 1024;
void protectedEvidence(Policy& policy, HANDLE h, bool directory) {
  policy.verify(h, directory, true);
  PSID owner; Local sd;
  DWORD error = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, nullptr, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&sd.value));
  if (error) fail("report evidence security descriptor", error);
  SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
  check(GetSecurityDescriptorControl(sd.value, &control, &revision), "report evidence DACL control");
  if (!(control & SE_DACL_PROTECTED) || !owner || !EqualSid(owner, policy.user))
    fail("report evidence requires current owner and protected DACL");
}
std::string reportIdentity(const Snapshot& s) {
  return std::to_string(s.identity.dwVolumeSerialNumber) + ":" + std::to_string(s.identity.nFileIndexHigh) + ":" +
    std::to_string(s.identity.nFileIndexLow) + ":" + std::to_string(s.identity.nFileSizeHigh) + ":" +
    std::to_string(s.identity.nFileSizeLow) + ":" + std::to_string(s.basic.CreationTime.QuadPart) + ":" +
    std::to_string(s.basic.LastWriteTime.QuadPart) + ":" + std::to_string(s.basic.ChangeTime.QuadPart);
}
struct ReportLease {
  std::unique_ptr<Chain> chain;
  Held file;
  std::unique_ptr<Snapshot> snapshot;
  std::wstring path;
  bool busy = false;
  void verify() {
    if (!file) fail("closed report evidence lease");
    chain->verify();
    protectedEvidence(chain->policy, chain->parent(), true);
    protectedEvidence(chain->policy, file->value, false);
    if (!snapshot->same(Snapshot(file->value))) fail("report evidence identity changed");
    // Compare against the pinned parent, not its caller spelling (which may
    // contain a legitimate Windows short-name ancestor). Chain already rejects
    // reparse points and drive aliases and validates every retained handle.
    auto parentName = finalName(chain->parent());
    if (parentName.back() != L'\\') parentName += L'\\';
    auto expected = parentName + chain->leaf, actual = finalName(file->value);
    if (CompareStringOrdinal(expected.c_str(), -1, actual.c_str(), -1, TRUE) != CSTR_EQUAL)
      fail("report evidence canonical containment mismatch");
  }
  std::vector<char> read(napi_env env = nullptr, napi_value hook = nullptr) {
    verify();
    // Independent open, not a cached buffer or shared file-position read.
    auto reader = relative(chain->parent(), chain->leaf, FILE_READ_DATA, Open, false, chain->policy, true, false);
    protectedEvidence(chain->policy, reader->value, false);
    if (!snapshot->same(Snapshot(reader->value))) fail("report evidence replaced");
    LARGE_INTEGER size; check(GetFileSizeEx(reader->value, &size), "report evidence size");
    if (size.QuadPart < 0 || size.QuadPart > ReportMaxBytes) fail("report evidence exceeds size bound");
    std::vector<char> bytes(static_cast<size_t>(size.QuadPart) + 1);
    DWORD used = 0;
    // Deterministic race probe after a partial native read. Not used by the
    // production wrapper; reentrancy/close are rejected while this is active.
    if (hook) {
      check(ReadFile(reader->value, bytes.data(), static_cast<DWORD>(bytes.size() / 2), &used, nullptr), "read report evidence prefix");
      sourceHook(env, hook, "duringRead", chain->leaf);
    }
    while (used < bytes.size()) {
      DWORD n;
      check(ReadFile(reader->value, bytes.data() + used, static_cast<DWORD>(bytes.size() - used), &n, nullptr), "read report evidence");
      if (!n) break;
      used += n;
    }
    protectedEvidence(chain->policy, reader->value, false);
    if (used != size.QuadPart || !snapshot->same(Snapshot(reader->value))) fail("report evidence changed during read");
    verify(); bytes.resize(used); return bytes;
  }
};
constexpr napi_type_tag ReportTag{0x762eaec5bb5943d0, 0xaf9b7c2ea9636b98};
ReportLease* reportLease(napi_env env, napi_value value) {
  bool tagged = false; void* p = nullptr;
  if (napi_check_object_type_tag(env, value, &ReportTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, value, &p) != napi_ok || !p) fail("invalid report evidence lease");
  return static_cast<ReportLease*>(p);
}
napi_value reportOperation(napi_env env, napi_callback_info info, int op) {
  try {
    napi_value args[2], result; size_t count = 2;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr); napi_get_undefined(env, &result);
    if (count < 1) fail("missing report evidence arguments");
    if (op == 0) {
      auto lease = std::make_unique<ReportLease>(); lease->path = stringArg(env, args[0]);
      lease->chain = std::make_unique<Chain>(lease->path, count == 2, L"");
      auto& chain = *lease->chain;
      wchar_t filesystem[32];
      check(GetVolumeInformationByHandleW(chain.parent(), nullptr, 0, nullptr, nullptr, nullptr, filesystem, 32), "report evidence filesystem");
      if (wcscmp(filesystem, L"NTFS") != 0) fail("report evidence requires local NTFS");
      protectedEvidence(chain.policy, chain.parent(), true);
      void* data = nullptr; size_t length = 0;
      std::unique_ptr<Snapshot> created;
      if (count == 2) {
        bool buffer = false;
        if (napi_is_buffer(env, args[1], &buffer) != napi_ok || !buffer ||
            napi_get_buffer_info(env, args[1], &data, &length) != napi_ok || length > ReportMaxBytes) fail("report evidence requires bounded Buffer");
        auto writer = relative(chain.parent(), chain.leaf, FILE_WRITE_DATA, Create, false, chain.policy, true, true);
        DWORD written;
        check(WriteFile(writer->value, data, static_cast<DWORD>(length), &written, nullptr), "write report evidence");
        if (written != length) fail("short report evidence write");
        check(FlushFileBuffers(writer->value), "flush report evidence");
        protectedEvidence(chain.policy, writer->value, false);
        created = std::make_unique<Snapshot>(writer->value);
      } // Close writer before acquiring read-only lease. Bind ID AND exact bytes
        // across this transition; never publish a partial or replaced artifact.
      lease->file = relative(chain.parent(), chain.leaf, FILE_READ_DATA, Open, false, chain.policy, true, false);
      lease->snapshot = std::make_unique<Snapshot>(lease->file->value);
      if (created && (created->identity.dwVolumeSerialNumber != lease->snapshot->identity.dwVolumeSerialNumber ||
          created->identity.nFileIndexHigh != lease->snapshot->identity.nFileIndexHigh ||
          created->identity.nFileIndexLow != lease->snapshot->identity.nFileIndexLow ||
          created->basic.CreationTime.QuadPart != lease->snapshot->basic.CreationTime.QuadPart)) fail("report evidence replaced during creation");
      auto bytes = lease->read();
      if (created && (bytes.size() != length || (length && memcmp(bytes.data(), data, length)))) fail("report evidence changed during creation");
      auto identity = reportIdentity(*lease->snapshot);
      napi_value holder, id;
      if (napi_create_object(env, &holder) != napi_ok || napi_type_tag_object(env, holder, &ReportTag) != napi_ok ||
          napi_wrap(env, holder, lease.get(), [](napi_env, void* p, void*) { delete static_cast<ReportLease*>(p); }, nullptr, nullptr) != napi_ok) fail("create report evidence lease");
      lease.release();
      napi_create_object(env, &result); napi_set_named_property(env, result, "lease", holder);
      napi_create_string_utf8(env, identity.data(), identity.size(), &id); napi_set_named_property(env, result, "identity", id);
    } else {
      auto lease = reportLease(env, args[0]);
      if (lease->busy) fail("busy report evidence lease");
      if (op == 2) { lease->file.reset(); lease->chain.reset(); }
      else {
        lease->busy = true;
        try {
          auto bytes = lease->read(env, count == 2 ? args[1] : nullptr);
          napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result);
        } catch (...) { lease->busy = false; throw; }
        lease->busy = false;
      }
    }
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value openReport(napi_env e, napi_callback_info i) { return reportOperation(e, i, 0); }
napi_value readReport(napi_env e, napi_callback_info i) { return reportOperation(e, i, 1); }
napi_value closeReport(napi_env e, napi_callback_info i) { return reportOperation(e, i, 2); }
