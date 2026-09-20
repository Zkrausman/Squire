// Test-only executable transport shim. Never linked into or loaded by production.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <string>
#include <vector>

// Windows CRT argv quoting, including empty strings and trailing backslashes.
std::wstring quote(const std::wstring& value) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    out.append(c == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0; out += c;
  }
  out.append(slashes * 2, L'\\');
  return out + L"\"";
}
int wmain(int argc, wchar_t** argv) {
  std::vector<wchar_t> buffer(32768);
  DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (!length || length >= buffer.size()) return 120;
  std::wstring executable(buffer.data(), length);
  auto directory = executable.substr(0, executable.find_last_of(L'\\') + 1);
  // Inspect the actual native command line, not a reconstructed argv vector.
  const wchar_t* actualCommand = GetCommandLineW();
  HANDLE observation = CreateFileW((directory + L"command-line.utf16").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
  if (observation == INVALID_HANDLE_VALUE) return 129;
  DWORD written = 0;
  BOOL recorded = WriteFile(observation, actualCommand, static_cast<DWORD>(wcslen(actualCommand) * sizeof(wchar_t)), &written, nullptr);
  CloseHandle(observation);
  if (!recorded) return 130;
  HANDLE config = CreateFileW((directory + L"node-path.utf16").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (config == INVALID_HANDLE_VALUE) return 121;
  DWORD size = GetFileSize(config, nullptr), read = 0;
  if (!size || size > 65534 || size % sizeof(wchar_t)) { CloseHandle(config); return 122; }
  std::wstring node(size / sizeof(wchar_t), L'\0');
  BOOL ok = ReadFile(config, node.data(), size, &read, nullptr); CloseHandle(config);
  if (!ok || read != size || node.find(L'\0') != std::wstring::npos || node.size() < 3 || node[1] != L':') return 123;
  // Keep real supervisor ownership observable despite the Windows exe shim.
  DWORD parent = 0;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 127;
  PROCESSENTRY32W process{}; process.dwSize = sizeof(process);
  if (Process32FirstW(snapshot, &process)) do {
    if (process.th32ProcessID == GetCurrentProcessId()) { parent = process.th32ParentProcessID; break; }
  } while (Process32NextW(snapshot, &process));
  CloseHandle(snapshot);
  if (!parent) return 128;
  std::wstring command = quote(node) + L" " + quote(directory + L"plan-sbx.cjs") + L" --shim-parent-pid=" + std::to_wstring(parent);
  for (int i = 1; i < argc; ++i) command += L" " + quote(argv[i]);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 124;
  CloseHandle(child.hThread);
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) { CloseHandle(child.hProcess); return 125; }
  DWORD status;
  if (!GetExitCodeProcess(child.hProcess, &status)) { CloseHandle(child.hProcess); return 126; }
  CloseHandle(child.hProcess); return static_cast<int>(status);
}
