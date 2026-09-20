// Observation opens are deliberately different from mutation/security leases:
// share all access, request only reads, and close only our own handles.
napi_value observeOwnerFile(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 1) fail("observation path required");
    auto name = stringArg(env, argv[0]);
    auto parts = components(name);
    if (GetDriveTypeW(parts[0].c_str()) != DRIVE_FIXED) fail("owner observation requires local fixed NTFS");
    std::vector<Held> ancestors;
    std::wstring prefix = parts[0];
    for (size_t i = 0; i < parts.size(); ++i) {
      if (i) { if (prefix.back() != L'\\') prefix += L'\\'; prefix += parts[i]; }
      bool leaf = i + 1 == parts.size();
      HANDLE raw = INVALID_HANDLE_VALUE;
      if (!i) {
        raw = CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
          FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
      } else {
        static auto ntCreate = reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
        static auto ntError = reinterpret_cast<NtError>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
        if (!ntCreate || !ntError) fail("native owner observation unavailable");
        UNICODE_STRING str{}; str.Buffer = const_cast<wchar_t*>(parts[i].data());
        str.Length = static_cast<USHORT>(parts[i].size() * sizeof(wchar_t)); str.MaximumLength = str.Length;
        OBJECT_ATTRIBUTES attr{}; attr.Length = sizeof(attr); attr.RootDirectory = ancestors.back()->value;
        attr.ObjectName = &str; attr.Attributes = OBJ_CASE_INSENSITIVE | DontReparse;
        IO_STATUS_BLOCK io{};
        NTSTATUS status = ntCreate(&raw, FILE_READ_ATTRIBUTES | SYNCHRONIZE | (leaf ? FILE_READ_DATA : FILE_TRAVERSE), &attr, &io,
          nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          Open, OpenReparse | Synchronous | (leaf ? NonDirectory : Directory), nullptr, 0);
        if (status < 0) { raw = INVALID_HANDLE_VALUE; SetLastError(ntError(status)); }
      }
      if (raw == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
          napi_value absent; napi_get_undefined(env, &absent); return absent;
        }
        fail("owner observation unreadable", error);
      }
      auto h = std::make_unique<Handle>(raw);
      BY_HANDLE_FILE_INFORMATION before{};
      check(GetFileInformationByHandle(raw, &before), "owner file identity");
      if (GetFileType(raw) != FILE_TYPE_DISK || (before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
          !!(before.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == leaf) fail("owner path is not regular");
      if (!i) {
        wchar_t filesystem[64];
        check(GetVolumeInformationByHandleW(raw, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 64), "owner volume");
        if (std::wstring(filesystem) != L"NTFS") fail("owner observation requires NTFS");
      }
      if (!leaf) { ancestors.push_back(std::move(h)); continue; }
      if (before.nNumberOfLinks != 1 || before.nFileSizeHigh || before.nFileSizeLow > 8192) fail("owner evidence size or links");
      char bytes[8193]; DWORD n;
      check(ReadFile(raw, bytes, sizeof(bytes), &n, nullptr), "owner bytes");
      BY_HANDLE_FILE_INFORMATION after{};
      check(GetFileInformationByHandle(raw, &after), "owner revalidation");
      if (n != before.nFileSizeLow || after.nFileSizeLow != before.nFileSizeLow ||
          CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime)) fail("owner bytes changed");
      // Validate the pathname again: handles never confer authority on a replacement.
      Handle again(CreateFileW(name.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      BY_HANDLE_FILE_INFORMATION current{};
      check(GetFileInformationByHandle(again.value, &current), "owner pathname revalidation");
      if ((current.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || current.dwVolumeSerialNumber != before.dwVolumeSerialNumber ||
          current.nFileIndexHigh != before.nFileIndexHigh || current.nFileIndexLow != before.nFileIndexLow) fail("owner pathname replaced");
      std::string identity = std::to_string(before.dwVolumeSerialNumber) + ":" + std::to_string(before.nFileIndexHigh) + ":" +
        std::to_string(before.nFileIndexLow) + ":" + std::to_string(before.ftCreationTime.dwHighDateTime) + ":" + std::to_string(before.ftCreationTime.dwLowDateTime);
      napi_value result, text, id;
      napi_create_object(env, &result); napi_create_string_utf8(env, bytes, n, &text);
      napi_create_string_utf8(env, identity.c_str(), identity.size(), &id);
      napi_set_named_property(env, result, "bytes", text); napi_set_named_property(env, result, "identity", id);
      return result;
    }
    fail("owner path missing leaf");
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value ownerProcessIdentity(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argv[1]; uint32_t pid;
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || !pid) fail("invalid owner PID");
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (process.value == nullptr) { process.value = INVALID_HANDLE_VALUE; fail("owner process unavailable"); }
    FILETIME creation, exit, kernel, user;
    check(GetProcessTimes(process.value, &creation, &exit, &kernel, &user), "owner creation identity");
    if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT) fail("owner process not live");
    std::string identity = std::to_string(creation.dwHighDateTime) + ":" + std::to_string(creation.dwLowDateTime);
    napi_value result; napi_create_string_utf8(env, identity.c_str(), identity.size(), &result); return result;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
