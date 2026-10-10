#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

// libSystem exports sandbox_check although the public SDK no longer declares it.
extern int sandbox_check(pid_t pid, const char *operation, int filter_type, ...);
#define FILTER_PATH 1
#define NO_REPORT 0x40000000

int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "--verify")) {
    pid_t pid = atoi(argv[2]);
    return pid > 1 && sandbox_check(pid, NULL, 0) > 0 &&
      sandbox_check(pid, "file-read-data", FILTER_PATH | NO_REPORT, argv[3]) == 0 &&
      sandbox_check(pid, "file-read-data", FILTER_PATH | NO_REPORT, argv[4]) > 0 ? 0 : 1;
  }
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') return 2;
  for (int pass = 0; pass < 32; pass++) {
    int size = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (size <= 0) { perror("proc_listpids"); return 1; }
    pid_t *pids = calloc(1, size + 4096 * sizeof(pid_t));
    if (!pids) return 1;
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, size + 4096 * sizeof(pid_t));
    if (bytes < 0) { free(pids); return 1; }
    int found = 0;
    for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
      pid_t pid = pids[i];
      if (pid <= 1 || pid == getpid() || pid == getppid()) continue;
      struct proc_bsdinfo before, after;
      if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) continue;
      // Each launch has a unique readable marker and an explicitly denied sentinel. Unsandboxed
      // processes allow both paths; other sandboxes do not allow this launch's marker.
      if (sandbox_check(pid, "file-read-data", FILTER_PATH | NO_REPORT, argv[1]) == 0 &&
          sandbox_check(pid, "file-read-data", FILTER_PATH | NO_REPORT, argv[2]) > 0) {
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after) ||
            before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec) continue;
        found++;
        if (kill(pid, SIGKILL) != 0 && errno != ESRCH) { perror("kill sandbox descendant"); free(pids); return 1; }
      }
    }
    free(pids);
    if (!found) return 0;
    usleep(10000);
  }
  fprintf(stderr, "Sandbox descendants could not be stopped.\n");
  return 1;
}
