// Test only. Success means the retained OS process reference signaled exit.
// stdin data/EOF cancels; deadlines bound broken-controller teardown, not liveness.
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <climits>
#ifdef _WIN32
#include <windows.h>
#include <fcntl.h>
#include <io.h>
static DWORD WINAPI cancel_on_input(void* event) {
  char byte;
  DWORD count;
  ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, nullptr);
  SetEvent(static_cast<HANDLE>(event));
  return 0;
}
#else
#include <poll.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif
int main(int argc, char** argv) {
  char* end = nullptr;
  if (argc != 2) return 3;
  errno = 0;
  long pid = std::strtol(argv[1], &end, 10);
  if (errno || *end || pid <= 0 || pid > INT_MAX) return 3;
#ifdef _WIN32
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 3;
  HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
  if (!process) { std::fprintf(stderr, "OpenProcess: %lu\n", GetLastError()); return 3; }
  HANDLE cancel = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE thread = cancel ? CreateThread(nullptr, 0, cancel_on_input, cancel, 0, nullptr) : nullptr;
  if (!thread) { CloseHandle(process); if (cancel) CloseHandle(cancel); return 3; }
  std::puts("acquired"); std::fflush(stdout);
  // Cancellation wins if both are signaled. The CRT process exit also ends the
  // blocking input thread; no detached helper process survives this executable.
  HANDLE handles[] = {cancel, process};
  DWORD result = WaitForMultipleObjects(2, handles, FALSE, 20000);
  CloseHandle(process);
  CloseHandle(thread);
  // Keep the event valid until process exit (the input thread may still use it).
  return result == WAIT_OBJECT_0 + 1 ? 0 : 2;
#else
  int fd = static_cast<int>(syscall(SYS_pidfd_open, static_cast<pid_t>(pid), 0));
  if (fd < 0) { std::perror("pidfd_open"); return 3; }
  std::puts("acquired"); std::fflush(stdout);
  struct pollfd handles[] = {{fd, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
  // EINTR fails closed rather than restarting a deadline or polling a PID.
  int result = poll(handles, 2, 20000);
  close(fd);
  return result > 0 && (handles[0].revents & POLLIN) && !(handles[0].revents & (POLLERR | POLLNVAL)) && handles[1].revents == 0 ? 0 : 2;
#endif
}
