// Landlock and seccomp enforce the boundary before exec; descendants inherit both restrictions.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/sched.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#if defined(__x86_64__)
#define ETA_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ETA_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported sandbox launcher architecture
#endif

static void fail(const char *message) { perror(message); exit(1); }
static const unsigned long long read_access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
static const unsigned long long write_access = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;

static void allow_path(int ruleset, const char *path, int writable) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) fail(path);
  struct stat info;
  if (fstat(fd, &info) != 0) fail("fstat");
  unsigned long long access = read_access | (writable ? write_access : 0);
  if (!S_ISDIR(info.st_mode)) access &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = fd };
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) fail("landlock_add_rule");
  close(fd);
}

#define DENY_SYSCALL(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(int network) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ETA_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    // x32 syscall numbers must not bypass the native syscall deny list.
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
    DENY_SYSCALL(SYS_ptrace),
    DENY_SYSCALL(SYS_process_vm_readv),
    DENY_SYSCALL(SYS_process_vm_writev),
    DENY_SYSCALL(SYS_pidfd_getfd),
    DENY_SYSCALL(SYS_open_by_handle_at),
    DENY_SYSCALL(SYS_mount),
    DENY_SYSCALL(SYS_pivot_root),
    DENY_SYSCALL(SYS_unshare),
    DENY_SYSCALL(SYS_setns),
    DENY_SYSCALL(SYS_bpf),
    DENY_SYSCALL(SYS_perf_event_open),
    DENY_SYSCALL(SYS_io_uring_setup),
    DENY_SYSCALL(SYS_io_uring_enter),
    DENY_SYSCALL(SYS_io_uring_register),
    DENY_SYSCALL(SYS_setsid),
    DENY_SYSCALL(SYS_setpgid),
    DENY_SYSCALL(SYS_kill),
    DENY_SYSCALL(SYS_tkill),
    DENY_SYSCALL(SYS_tgkill),
    DENY_SYSCALL(SYS_pidfd_send_signal),
    // glibc falls back to clone when clone3 is unavailable. Its pointer arguments cannot be
    // safely filtered; inspect clone's flags and reject namespace creation before continuing.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    // Isolated stream pairs support child-process IPC. Datagram pairs could reconnect to a host
    // Unix socket, so they are not permitted even with an internet grant.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 9),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0xf),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 0, 2),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    // No new sockets by default. A network grant permits TCP/UDP, never host Unix sockets.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, network ? AF_INET : 0xffffffff, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, network ? AF_INET6 : 0xffffffff, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) fail("seccomp");
}

int main(int argc, char **argv) {
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) { fprintf(stderr, "Eta sandbox requires Landlock ABI 3 or newer (including truncate enforcement).\n"); return 1; }
  struct landlock_ruleset_attr rules = { .handled_access_fs = read_access | write_access };
  int ruleset = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (ruleset < 0) fail("landlock_create_ruleset");
  int network = 0, command = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { command = i + 1; break; }
    if (!strcmp(argv[i], "--network")) { network = 1; continue; }
    int writable = !strcmp(argv[i], "--write");
    if ((!writable && strcmp(argv[i], "--read")) || i + 1 >= argc) { fprintf(stderr, "Invalid sandbox arguments.\n"); return 1; }
    allow_path(ruleset, argv[++i], writable);
  }
  if (!command || command >= argc) { fprintf(stderr, "Missing sandbox command.\n"); return 1; }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no_new_privs");
  struct __user_cap_header_struct cap_header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct cap_data[2] = { {0}, {0} };
  if (syscall(SYS_capset, &cap_header, cap_data) < 0) fail("drop capabilities");
  if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) fail("landlock_restrict_self");
  close(ruleset);
  restrict_syscalls(network);
  execv(argv[command], &argv[command]);
  fail("execv");
}
