// Windows-only launch boundary. All descendant opens are relative to retained
// NT directory handles; no pathname reopen is used for trusted bytes or rename.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include <uv.h>
#include <memory>
#include <string>
#include <vector>
#include <unordered_map>
#include <stdexcept>

namespace {
constexpr ULONG OpenReparse = 0x00200000, Directory = 1, NonDirectory = 0x40;
constexpr ULONG Synchronous = 0x20, DontReparse = 0x1000;
constexpr ULONG Open = 1, Create = 2, OpenIf = 3;
constexpr size_t MaxBytes = 8000000;
using NtCreate = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtError = ULONG (WINAPI*)(NTSTATUS);
using NtSet = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE v = INVALID_HANDLE_VALUE) : value(v) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
};
using Held = std::unique_ptr<Handle>;
struct Local { void* value = nullptr; ~Local() { if (value) LocalFree(value); } };
[[noreturn]] void fail(const char* label, DWORD error = 0) {
  throw std::runtime_error(std::string("Windows launch security: ") + label +
    (error ? " (Win32 " + std::to_string(error) + ")" : ""));
}
void check(BOOL ok, const char* label) { if (!ok) fail(label, GetLastError()); }
std::wstring stringArg(napi_env env, napi_value v) {
  size_t n;
  if (napi_get_value_string_utf16(env, v, nullptr, 0, &n) != napi_ok) fail("expected string");
  if (n > MaxBytes) fail("argument too large");
  std::vector<char16_t> b(n + 1);
  if (napi_get_value_string_utf16(env, v, b.data(), b.size(), &n) != napi_ok) fail("invalid string");
  std::wstring s(reinterpret_cast<wchar_t*>(b.data()), n);
  if (s.find(L'\0') != std::wstring::npos) fail("NUL in argument");
  return s;
}
struct Policy {
  std::vector<BYTE> token;
  Local system, admins, installer, descriptor;
  PSID user;
  Policy() {
    HANDLE t;
    check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &t), "open token");
    Handle h(t); DWORD n = 0;
    GetTokenInformation(t, TokenUser, nullptr, 0, &n);
    token.resize(n);
    check(GetTokenInformation(t, TokenUser, token.data(), n, &n), "token user");
    user = reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid;
    check(ConvertStringSidToSidW(L"S-1-5-18", &system.value), "SYSTEM SID");
    check(ConvertStringSidToSidW(L"S-1-5-32-544", &admins.value), "Administrators SID");
    check(ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer.value), "TrustedInstaller SID");
    Local sid;
    check(ConvertSidToStringSidW(user, reinterpret_cast<LPWSTR*>(&sid.value)), "user SID");
    std::wstring s = L"O:" + std::wstring(static_cast<wchar_t*>(sid.value)) +
      L"D:P(A;OICI;FA;;;" + std::wstring(static_cast<wchar_t*>(sid.value)) + L")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(s.c_str(), SDDL_REVISION_1,
      reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value), nullptr), "protected DACL");
  }
  bool trusted(PSID sid, bool ancestor) const {
    return IsValidSid(sid) && (EqualSid(sid, user) || EqualSid(sid, system.value) ||
      EqualSid(sid, admins.value) || (ancestor && EqualSid(sid, installer.value)));
  }
  void verify(HANDLE h, bool directory, bool confidential) const {
    BY_HANDLE_FILE_INFORMATION info;
    check(GetFileInformationByHandle(h, &info), "file identity");
    if (GetFileType(h) != FILE_TYPE_DISK || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory || (!directory && info.nNumberOfLinks != 1))
      fail("reparse, nonregular, or hardlinked object");
    PSID owner; PACL acl; Local sd;
    DWORD error = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&sd.value));
    if (error) fail("read handle DACL", error);
    if (!owner || !trusted(owner, !confidential) || !acl || !IsValidAcl(acl)) fail("unsafe owner or absent DACL");
    // Conservative allow-ACE analysis: deny ACEs never excuse an unsafe allow.
    // Ancestor read/traverse and child creation are not replacement authority.
    // DELETE on this object and DELETE_CHILD on its parent are both checked.
    constexpr DWORD mutation = DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD |
      FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
    GENERIC_MAPPING mapping{ FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
    for (DWORD i = 0; i < acl->AceCount; ++i) {
      void* raw;
      check(GetAce(acl, i, &raw), "read ACE");
      auto header = static_cast<ACE_HEADER*>(raw);
      if (header->AceFlags & INHERIT_ONLY_ACE) continue;
      if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
      // Object/callback/conditional ACE semantics are not guessed.
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) fail("unsupported DACL ACE");
      auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      DWORD mask = ace->Mask; MapGenericMask(&mask, &mapping);
      if (!trusted(&ace->SidStart, !confidential) && (confidential ? mask != 0 : (mask & mutation) != 0))
        fail(confidential ? "unexpected protected-object principal" : "unsafe ancestor mutation principal");
    }
  }
};
Held relative(HANDLE parent, const std::wstring& name, DWORD access, ULONG disposition,
              bool directory, Policy& policy, bool confidential, bool canCreate) {
  static auto ntCreate = reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  static auto ntError = reinterpret_cast<NtError>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
  if (!ntCreate || !ntError) fail("NT handle-relative support unavailable");
  UNICODE_STRING str{}; str.Buffer = const_cast<wchar_t*>(name.c_str());
  str.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t)); str.MaximumLength = str.Length;
  OBJECT_ATTRIBUTES attr{}; attr.Length = sizeof(attr); attr.RootDirectory = parent;
  attr.ObjectName = &str; attr.Attributes = OBJ_CASE_INSENSITIVE | DontReparse;
  attr.SecurityDescriptor = canCreate ? policy.descriptor.value : nullptr;
  IO_STATUS_BLOCK io{}; HANDLE h;
  // Directory handles deny delete-sharing, but relative opens + DACL/reparse
  // validation (not sharing alone) establish ancestor integrity. Files deny
  // write/delete sharing for stable reads and to reject existing writers.
  NTSTATUS status = ntCreate(&h, access | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attr, &io,
    nullptr, FILE_ATTRIBUTE_NORMAL, directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ,
    disposition, OpenReparse | Synchronous | (directory ? Directory : NonDirectory), nullptr, 0);
  if (status < 0) {
    DWORD error = ntError(status);
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) fail("ENOENT: launch object missing", error);
    fail("handle-relative open rejected", error);
  }
  auto result = std::make_unique<Handle>(h);
  policy.verify(h, directory, confidential);
  return result;
}
std::vector<std::wstring> components(const std::wstring& file) {
  // Local drive paths only: reject UNC/devices/ADS/DOS aliases/relative paths.
  if (file.size() < 4 || file[1] != L':' || file[2] != L'\\' ||
      !((file[0] >= L'A' && file[0] <= L'Z') || (file[0] >= L'a' && file[0] <= L'z'))) fail("local absolute drive path required");
  std::vector<std::wstring> parts{file.substr(0, 3)};
  size_t start = 3;
  while (start < file.size()) {
    size_t end = file.find(L'\\', start);
    if (end == std::wstring::npos) end = file.size();
    auto p = file.substr(start, end - start);
    if (p.empty() || p.size() > 255 || p == L"." || p == L".." || p.back() == L'.' || p.back() == L' ' ||
        p.find_first_of(L"/:*?\"<>|") != std::wstring::npos) fail("unsafe path component");
    auto base = p.substr(0, p.find(L'.'));
    for (auto& c : base) if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
    if (base == L"CON" || base == L"PRN" || base == L"AUX" || base == L"NUL" ||
        (base.size() == 4 && (base.substr(0, 3) == L"COM" || base.substr(0, 3) == L"LPT") && base[3] >= L'1' && base[3] <= L'9')) fail("DOS device path rejected");
    parts.push_back(p); start = end + 1;
  }
  if (parts.size() < 2 || file.back() == L'\\') fail("file path required");
  return parts;
}
std::wstring finalName(HANDLE h) {
  std::vector<wchar_t> b(32768);
  DWORD n = GetFinalPathNameByHandleW(h, b.data(), static_cast<DWORD>(b.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!n || n >= b.size()) fail("canonical handle path", GetLastError());
  return std::wstring(b.data(), n);
}
bool within(std::wstring parent, std::wstring child) {
  if (parent.rfind(L"\\\\?\\", 0) != 0) parent = L"\\\\?\\" + parent;
  while (parent.back() == L'\\') parent.pop_back();
  if (child.size() < parent.size() || CompareStringOrdinal(parent.c_str(), static_cast<int>(parent.size()),
      child.c_str(), static_cast<int>(parent.size()), TRUE) != CSTR_EQUAL) return false;
  return child.size() == parent.size() || child[parent.size()] == L'\\';
}
struct Chain {
  Policy policy;
  std::vector<Held> handles;
  std::wstring leaf;
  Chain(const std::wstring& file, bool create, const std::wstring& repository) {
    auto parts = components(file); leaf = parts.back();
    if (GetDriveTypeW(parts[0].c_str()) != DRIVE_FIXED) fail("local fixed drive required");
    auto root = std::make_unique<Handle>(CreateFileW(parts[0].c_str(), FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (root->value == INVALID_HANDLE_VALUE) fail("open volume root", GetLastError());
    policy.verify(root->value, true, false);
    auto canonicalRoot = finalName(root->value);
    auto expectedRoot = L"\\\\?\\" + parts[0];
    if (CompareStringOrdinal(canonicalRoot.c_str(), -1, expectedRoot.c_str(), -1, TRUE) != CSTR_EQUAL)
      fail("drive aliases cannot bypass the full ancestor chain");
    handles.push_back(std::move(root));
    for (size_t i = 1; i + 1 < parts.size(); ++i) {
      // Missing dedicated children are protected at creation. Existing broad
      // ancestors need integrity, while the immediate byte-container needs
      // confidentiality. No existing object's ACL is ever repaired.
      handles.push_back(relative(parent(), parts[i], FILE_TRAVERSE, create ? OpenIf : Open,
        true, policy, i + 2 == parts.size(), create));
    }
    if (!repository.empty() && within(repository, finalName(parent()))) fail("launch material must be outside repository");
  }
  HANDLE parent() const { return handles.back()->value; }
  void verify() {
    for (size_t i = 0; i < handles.size(); ++i) policy.verify(handles[i]->value, true, i + 1 == handles.size());
  }
};
std::string bytesArg(napi_env env, napi_value v) {
  size_t n; if (napi_get_value_string_utf8(env, v, nullptr, 0, &n) != napi_ok || n > MaxBytes) fail("invalid/oversized bytes");
  std::vector<char> b(n + 1);
  if (napi_get_value_string_utf8(env, v, b.data(), b.size(), &n) != napi_ok) fail("invalid bytes");
  return std::string(b.data(), n);
}
void write(Chain& chain, const std::string& bytes, napi_env env, napi_value hook) {
  // Unique temporary name, CREATE (never OPEN_IF). Rename is relative to the
  // retained directory; no pathname race or overwrite of an existing envelope.
  LARGE_INTEGER counter; QueryPerformanceCounter(&counter);
  auto temp = chain.leaf + L"." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(counter.QuadPart) + L".tmp";
  auto file = relative(chain.parent(), temp, FILE_WRITE_DATA | DELETE, Create, false, chain.policy, true, true);
  bool renamed = false;
  try {
    DWORD written;
    check(WriteFile(file->value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr), "write bytes");
    if (written != bytes.size()) fail("short write");
    check(FlushFileBuffers(file->value), "flush bytes");
    // Test-only synchronous seam after temporary-file pinning, before publish.
    if (hook) {
      napi_value receiver, ignored; napi_get_undefined(env, &receiver);
      if (napi_call_function(env, receiver, hook, 0, nullptr, &ignored) != napi_ok) fail("publication hook failed");
    }
    chain.verify(); chain.policy.verify(file->value, false, true);
    auto n = chain.leaf.size() * sizeof(wchar_t);
    std::vector<BYTE> buffer(sizeof(FILE_RENAME_INFO) + n);
    auto info = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    info->ReplaceIfExists = FALSE; info->RootDirectory = chain.parent(); info->FileNameLength = static_cast<DWORD>(n);
    memcpy(info->FileName, chain.leaf.data(), n);
    // Win32 SetFileInformationByHandle rejects a non-null RootDirectory;
    // NT FileRenameInformation supports the retained handle-relative target.
    static auto ntSet = reinterpret_cast<NtSet>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
    static auto ntError = reinterpret_cast<NtError>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    if (!ntSet || !ntError) fail("NT handle-relative rename unavailable");
    IO_STATUS_BLOCK io{};
    NTSTATUS status = ntSet(file->value, &io, info, static_cast<ULONG>(buffer.size()), static_cast<FILE_INFORMATION_CLASS>(10));
    if (status < 0) fail("publish immutable bytes", ntError(status));
    renamed = true;
  } catch (...) {
    if (!renamed) { FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(file->value, FileDispositionInfo, &remove, sizeof(remove)); }
    throw;
  }
}
struct Log {
  std::unique_ptr<Chain> chain;
  int fd;
  ~Log() { uv_fs_t request; uv_fs_close(nullptr, &request, fd, nullptr); uv_fs_req_cleanup(&request); }
};
// Environment-owned leases retain directory handles through the spawn boundary.
struct Context { std::unordered_map<int, std::unique_ptr<Log>> logs; };
Context* context(napi_env env) { void* p; napi_get_instance_data(env, &p); return static_cast<Context*>(p); }
napi_value operation(napi_env env, napi_callback_info info, int op) {
  try {
    napi_value args[4]; size_t count = 4;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    napi_value result; napi_get_undefined(env, &result);
    if (op == 3) {
      int fd; if (count != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok) fail("invalid log lease");
      if (!context(env)->logs.erase(fd)) fail("unknown log lease");
      return result;
    }
    if (count < (op == 2 ? 1u : 2u)) fail("missing arguments");
    auto filePath = stringArg(env, args[0]);
    auto repository = op == 2 ? L"" : stringArg(env, args[1]);
    auto chain = std::make_unique<Chain>(filePath, op != 1, repository);
    if (op == 0) {
      if (count < 3) fail("missing bytes");
      write(*chain, bytesArg(env, args[2]), env, count >= 4 ? args[3] : nullptr);
    } else if (op == 1) {
      auto file = relative(chain->parent(), chain->leaf, FILE_READ_DATA, Open, false, chain->policy, true, false);
      // Explicit synchronous race-test seam, called only after native pinning.
      if (count >= 3) {
        napi_value ignored;
        if (napi_call_function(env, result, args[2], 0, nullptr, &ignored) != napi_ok) return nullptr;
      }
      LARGE_INTEGER size; check(GetFileSizeEx(file->value, &size), "read size");
      if (size.QuadPart < 0 || size.QuadPart > MaxBytes) fail("oversized launch material");
      std::vector<char> bytes(static_cast<size_t>(size.QuadPart) + 1); DWORD n;
      check(ReadFile(file->value, bytes.data(), static_cast<DWORD>(bytes.size()), &n, nullptr), "read bytes");
      if (n != size.QuadPart) fail("changed launch material size");
      chain->verify(); chain->policy.verify(file->value, false, true);
      napi_create_string_utf8(env, bytes.data(), n, &result);
    } else {
      auto file = relative(chain->parent(), chain->leaf, FILE_APPEND_DATA, OpenIf, false, chain->policy, true, true);
      chain->verify();
      // Use Node's libuv CRT descriptor table, not the addon's private CRT.
      // FILE_APPEND_DATA on the native handle enforces append-only writes.
      int fd = uv_open_osfhandle(file->value);
      if (fd < 0) fail("create inherited log descriptor");
      file->value = INVALID_HANDLE_VALUE;
      auto log = std::make_unique<Log>(); log->fd = fd; log->chain = std::move(chain);
      context(env)->logs.emplace(fd, std::move(log)); napi_create_int32(env, fd, &result);
    }
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value persist(napi_env e, napi_callback_info i) { return operation(e, i, 0); }
napi_value read(napi_env e, napi_callback_info i) { return operation(e, i, 1); }
napi_value openLog(napi_env e, napi_callback_info i) { return operation(e, i, 2); }
napi_value closeLog(napi_env e, napi_callback_info i) { return operation(e, i, 3); }
#include "windows-state-replace.h"

napi_value init(napi_env env, napi_value exports) {
  napi_set_instance_data(env, new Context(), [](napi_env, void* p, void*) { delete static_cast<Context*>(p); }, nullptr);
  napi_property_descriptor methods[] = {
    {"persist", nullptr, persist, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openLog", nullptr, openLog, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeLog", nullptr, closeLog, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"replaceState", nullptr, replaceState, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 5, methods); return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
