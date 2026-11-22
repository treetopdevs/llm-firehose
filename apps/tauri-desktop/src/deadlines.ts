/** How long a view waits for the daemon before it calls a read failed. A daemon over a large
 *  spool on a busy machine answers /attention and /worktrees in tens of seconds; giving up at
 *  ten drew "could not load" over data that was on its way, and each retry asked again. */
export const READ_DEADLINE_MS = 60_000;
