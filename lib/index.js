// dsh-watch-together — the meta package.
//
// It carries no behaviour of its own: the six sibling packages are the stack,
// and each of them fails on its own so a dead microphone does not blind the
// eyes.
//
// Installing this package does NOT mount the stack. DSH registers a package as
// a profile layer only when it is a direct dependency of the profile and
// declares dsh.bundle. This package declares none, and the six siblings it pulls
// in are transitive dependencies, so none of them is mounted. Install the six
// directly instead (one command is enough):
//
//   dsh plugin --profile desktop add dsh-watch-eyes dsh-watch-ears dsh-watch-mouth dsh-watch-browser dsh-watch-hands dsh-watch-panel
export const name = 'dsh-watch-stack'

export const inject = []

export const services = [
  'dsh-watch-eyes',
  'dsh-watch-ears',
  'dsh-watch-mouth',
  'dsh-watch-browser',
  'dsh-watch-hands',
  'dsh-watch-panel',
]

export function apply() {
  // Nothing to mount: each sibling ships its own cordis patch and is mounted
  // when it is itself a direct dependency of the profile (see the top of this
  // file). Mounting them here as well would mount every service twice.
}
