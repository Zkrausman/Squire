// Included inside the existing addon namespace. State replacement only: this
// does not change immutable launch publication or best-effort event outboxes.
struct StateReplaceError : std::runtime_error {
  DWORD error;
  StateReplaceError(const char* operation, DWORD code) : std::runtime_error(operation), error(code) {}
};
void stateCheck(BOOL ok, const char* label) {
  if (!ok) throw StateReplaceError(label, GetLastError());
}
void stateRegular(HANDLE h, bool directory) {
  BY_HANDLE_FILE_INFORMATION info{};
  stateCheck(GetFileInformationByHandle(h, &info), "inspect replacement object");
  if (GetFileType(h) != FILE_TYPE_DISK || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
      (!directory && (info.nNumberOfLinks != 1 || (info.dwFileAttributes & FILE_ATTRIBUTE_READONLY))))
    throw StateReplaceError("unsafe replacement object", ERROR_ACCESS_DENIED);
}
Held stateRelative(HANDLE parent, const std::wstring& name, DWORD access, bool directory, DWORD share) {
  static auto create = reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  static auto translate = reinterpret_cast<NtError>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
  if (!create || !translate) throw StateReplaceError("relative open unavailable", ERROR_NOT_SUPPORTED);
  UNICODE_STRING str{}; str.Buffer = const_cast<wchar_t*>(name.c_str());
  str.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t)); str.MaximumLength = str.Length;
  OBJECT_ATTRIBUTES attr{}; attr.Length = sizeof(attr); attr.RootDirectory = parent;
  attr.ObjectName = &str; attr.Attributes = OBJ_CASE_INSENSITIVE | DontReparse;
  IO_STATUS_BLOCK io{}; HANDLE raw;
  NTSTATUS status = create(&raw, access | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attr, &io,
    nullptr, FILE_ATTRIBUTE_NORMAL, share, Open,
    OpenReparse | Synchronous | (directory ? Directory : NonDirectory), nullptr, 0);
  if (status < 0) throw StateReplaceError("open replacement object", translate(status));
  auto handle = std::make_unique<Handle>(raw); stateRegular(raw, directory); return handle;
}
void replaceStateFile(const std::wstring& source, const std::wstring& destination) {
  auto from = components(source), to = components(destination);
  if (from.size() != to.size()) throw StateReplaceError("same-directory replacement required", ERROR_INVALID_PARAMETER);
  for (size_t i = 0; i + 1 < from.size(); ++i) {
    if (CompareStringOrdinal(from[i].c_str(), -1, to[i].c_str(), -1, TRUE) != CSTR_EQUAL)
      throw StateReplaceError("same-directory replacement required", ERROR_INVALID_PARAMETER);
  }
  if (CompareStringOrdinal(from.back().c_str(), -1, to.back().c_str(), -1, TRUE) == CSTR_EQUAL)
    throw StateReplaceError("distinct replacement files required", ERROR_INVALID_PARAMETER);
  if (GetDriveTypeW(from[0].c_str()) != DRIVE_FIXED)
    throw StateReplaceError("local fixed NTFS volume required", ERROR_NOT_SUPPORTED);
  std::vector<Held> parents;
  auto root = std::make_unique<Handle>(CreateFileW(from[0].c_str(), FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  stateCheck(root->value != INVALID_HANDLE_VALUE, "open replacement volume");
  stateRegular(root->value, true);
  if (CompareStringOrdinal(finalName(root->value).c_str(), -1, (L"\\\\?\\" + from[0]).c_str(), -1, TRUE) != CSTR_EQUAL)
    throw StateReplaceError("drive aliases unsupported", ERROR_NOT_SUPPORTED);
  wchar_t filesystem[32]{};
  stateCheck(GetVolumeInformationByHandleW(root->value, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 32), "inspect replacement filesystem");
  if (wcscmp(filesystem, L"NTFS") != 0)
    throw StateReplaceError("NTFS replacement required", ERROR_NOT_SUPPORTED);
  parents.push_back(std::move(root));
  for (size_t i = 1; i + 1 < from.size(); ++i)
    parents.push_back(stateRelative(parents.back()->value, from[i], FILE_TRAVERSE, true, FILE_SHARE_READ | FILE_SHARE_WRITE));
  // No ancestor can be renamed while retained. Open the source relative to the
  // pinned parent, excluding surviving writers and source replacement.
  HANDLE parent = parents.back()->value;
  auto file = stateRelative(parent, from.back(), DELETE, false, FILE_SHARE_READ);
  auto target = stateRelative(parent, to.back(), FILE_READ_ATTRIBUTES, false,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  BY_HANDLE_FILE_INFORMATION a{}, b{};
  stateCheck(GetFileInformationByHandle(file->value, &a), "source identity");
  stateCheck(GetFileInformationByHandle(target->value, &b), "target identity");
  if (a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow)
    throw StateReplaceError("replacement aliases source", ERROR_INVALID_PARAMETER);
  // Win32 requires null RootDirectory. The absolute name is derived from the
  // retained canonical parent, not reopened through unpinned pathname parents.
  const auto name = finalName(parent) + L"\\" + to.back();
  const size_t bytes = name.size() * sizeof(wchar_t);
  std::vector<BYTE> buffer(offsetof(FILE_RENAME_INFO, FileName) + bytes + sizeof(wchar_t), 0);
  auto rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
  rename->RootDirectory = nullptr;
  rename->FileNameLength = static_cast<DWORD>(bytes);
  memcpy(rename->FileName, name.c_str(), bytes + sizeof(wchar_t));
  // Never use IGNORE_READONLY_ATTRIBUTE, pre-unlink, or legacy fallback. API or
  // filesystem rejection remains a failure with both files intact.
  stateCheck(SetFileInformationByHandle(file->value, FileRenameInfoEx, rename,
    static_cast<DWORD>(buffer.size())), "replace state file");
}
napi_value replaceState(napi_env env, napi_callback_info info) {
  try {
    napi_value args[2]; size_t count = 2;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 2) throw StateReplaceError("two replacement paths required", ERROR_INVALID_PARAMETER);
    replaceStateFile(stringArg(env, args[0]), stringArg(env, args[1]));
    napi_value result; napi_get_undefined(env, &result); return result;
  } catch (const StateReplaceError& error) {
    const int code = uv_translate_sys_error(error.error);
    napi_value message, object, value;
    napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &object);
    napi_create_string_utf8(env, uv_err_name(code), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, "code", value);
    napi_create_int32(env, code, &value); napi_set_named_property(env, object, "errno", value);
    napi_create_uint32(env, error.error, &value); napi_set_named_property(env, object, "win32Code", value);
    napi_create_string_utf8(env, "rename", NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, "syscall", value);
    napi_throw(env, object); return nullptr;
  } catch (const std::exception& error) { napi_throw_error(env, "EINVAL", error.what()); return nullptr; }
}
