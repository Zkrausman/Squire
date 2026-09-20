// Read/query rights only. File descriptors belong to this observer, never the
// controller. Sharing is supplied by Node's ordinary read-only open (R/W/D).
napi_value observationFileIdentity(napi_env env, napi_callback_info info) {
  try {
    napi_value arg, result; size_t count = 1; int32_t fd;
    napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
    if (count != 1 || napi_get_value_int32(env, arg, &fd) != napi_ok || fd < 0) fail("invalid observation descriptor");
    HANDLE h = reinterpret_cast<HANDLE>(uv_get_osfhandle(fd));
    BY_HANDLE_FILE_INFORMATION f{};
    check(GetFileInformationByHandle(h, &f), "observation file identity");
    if (GetFileType(h) != FILE_TYPE_DISK || f.nNumberOfLinks != 1 ||
        (f.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) fail("nonregular observation file");
    wchar_t filesystem[32]{};
    check(GetVolumeInformationByHandleW(h, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 32), "observation filesystem");
    const auto canonical = finalName(h);
    if (wcscmp(filesystem, L"NTFS") != 0 || canonical.size() < 7 || canonical.rfind(L"\\\\?\\", 0) != 0 ||
        canonical[5] != L':' || GetDriveTypeW(canonical.substr(4, 3).c_str()) != DRIVE_FIXED) fail("local fixed NTFS observation required");
    auto identity = std::to_string(f.dwVolumeSerialNumber) + ":" + std::to_string(f.nFileIndexHigh) + ":" +
      std::to_string(f.nFileIndexLow) + ":" + std::to_string(f.ftCreationTime.dwHighDateTime) + ":" + std::to_string(f.ftCreationTime.dwLowDateTime);
    napi_create_string_utf8(env, identity.c_str(), identity.size(), &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
constexpr napi_type_tag ProcessObservationTag{0x58aa369fa24d114a, 0xbaa58cc35d1b00a4};
struct ProcessObservation { Held process; };
napi_value processObservation(napi_env env, napi_callback_info info, int op) {
  try {
    napi_value arg, result; size_t count = 1;
    napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr); napi_get_undefined(env, &result);
    if (count != 1) fail("invalid process observation arguments");
    if (op == 0) {
      uint32_t pid; double number;
      if (napi_get_value_double(env, arg, &number) != napi_ok || number < 1 || number > 4294967295.0 ||
          napi_get_value_uint32(env, arg, &pid) != napi_ok || number != pid) fail("invalid observation PID");
      auto lease = std::make_unique<ProcessObservation>();
      HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
      if (!h) fail("open observation process", GetLastError());
      lease->process = std::make_unique<Handle>(h);
      if (napi_create_object(env, &result) != napi_ok || napi_type_tag_object(env, result, &ProcessObservationTag) != napi_ok ||
          napi_wrap(env, result, lease.get(), [](napi_env, void* p, void*) { delete static_cast<ProcessObservation*>(p); }, nullptr, nullptr) != napi_ok) fail("create process observation");
      lease.release();
    } else {
      bool tagged = false; void* p = nullptr;
      if (napi_check_object_type_tag(env, arg, &ProcessObservationTag, &tagged) != napi_ok || !tagged ||
          napi_unwrap(env, arg, &p) != napi_ok || !p) fail("invalid process observation");
      auto lease = static_cast<ProcessObservation*>(p);
      if (!lease->process) fail("closed process observation");
      if (op == 2) { lease->process.reset(); return result; }
      HANDLE h = lease->process->value;
      if (WaitForSingleObject(h, 0) != WAIT_TIMEOUT) fail("observation process exited or unreadable");
      FILETIME created, exited, kernel, user;
      check(GetProcessTimes(h, &created, &exited, &kernel, &user), "observation process creation");
      auto identity = std::to_string(created.dwHighDateTime) + ":" + std::to_string(created.dwLowDateTime);
      napi_create_string_utf8(env, identity.c_str(), identity.size(), &result);
    }
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value openObservationProcess(napi_env e, napi_callback_info i) { return processObservation(e, i, 0); }
napi_value readObservationProcess(napi_env e, napi_callback_info i) { return processObservation(e, i, 1); }
napi_value closeObservationProcess(napi_env e, napi_callback_info i) { return processObservation(e, i, 2); }
