#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <linux/sched.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  (void)argv;
  int pair[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0);
  close(pair[0]); close(pair[1]);
  assert(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == -1 && errno == EPERM);
  assert(socket(AF_UNIX, SOCK_STREAM, 0) == -1 && errno == EPERM);
  int network = socket(AF_INET, SOCK_STREAM, 0);
  if (argc > 1) { assert(network >= 0); close(network); }
  else assert(network == -1 && errno == EPERM);
  assert(setsid() == -1 && errno == EPERM);
  assert(setpgid(0, 0) == -1 && errno == EPERM);
  assert(syscall(SYS_process_vm_readv, getppid(), 0, 0, 0, 0, 0) == -1 && errno == EPERM);
  assert(kill(getppid(), 0) == -1 && errno == EPERM);
  assert(syscall(SYS_io_uring_setup, 1, 0) == -1 && errno == EPERM);
  assert(syscall(SYS_clone3, 0, 0) == -1 && errno == ENOSYS);
  assert(syscall(SYS_clone, CLONE_NEWUSER, 0, 0, 0, 0) == -1 && errno == EPERM);
  return 0;
}
