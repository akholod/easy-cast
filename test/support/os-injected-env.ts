/**
 * Variables the operating system puts into a child process by itself.
 *
 * macOS inserts `__CF_USER_TEXT_ENCODING` into everything it starts, below any
 * level Node can reach: a child spawned with `env: {}` still arrives carrying it.
 * CI on macos-latest found this; it does not reproduce on Linux.
 *
 * The property the leak tests are actually asserting is "nothing the parent held
 * reaches the child". A variable the OS inserts was never held by the parent, so
 * it is dropped — but by **exact name**, and from one list shared by every test
 * that needs it. Two copies of this rule would drift, and a pattern like
 * `/^__/` would be a blanket exemption that quietly turns the assertions vacuous.
 *
 * If a platform starts adding something else, the tests fail, and that is the
 * intended outcome: the new name belongs here only once somebody has looked at it.
 */
const OS_INJECTED = new Set(['__CF_USER_TEXT_ENCODING']);

export const isOsInjected = (name: string): boolean => OS_INJECTED.has(name);

export const withoutOsInjected = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !isOsInjected(name)));
