import { trampolineServer } from './trampoline-server'
import { withTrampolineToken } from './trampoline-tokens'
import * as Path from 'path'
import { getDesktopTrampolineFilename } from 'desktop-trampoline'
import { TrampolineCommandIdentifier } from '../trampoline/trampoline-command'
import { getSSHEnvironment } from '../ssh/ssh'
import {
  removePendingSSHSecretToStore,
  storePendingSSHSecret,
} from '../ssh/ssh-secret-storage'
import { GitProcess } from 'dugite'
import memoizeOne from 'memoize-one'
import { enableCustomGitUserAgent } from '../feature-flag'

export const GitUserAgent = memoizeOne(() =>
  // Can't use git() as that will call withTrampolineEnv which calls this method
  GitProcess.exec(['--version'], process.cwd())
    // https://github.com/git/git/blob/a9e066fa63149291a55f383cfa113d8bdbdaa6b3/help.c#L733-L739
    .then(r => /git version (.*)/.exec(r.stdout)?.at(1))
    .catch(e => {
      log.warn(`Could not get git version information`, e)
      return 'unknown'
    })
    .then(v => {
      const suffix = __DEV__ ? `-${__SHA__.substring(0, 10)}` : ''
      const ghdVersion = `GitHub Desktop/${__APP_VERSION__}${suffix}`
      const { platform, arch } = process

      return `git/${v} (${ghdVersion}; ${platform} ${arch})`
    })
)

/**
 * Allows invoking a function with a set of environment variables to use when
 * invoking a Git subcommand that needs to use the trampoline (mainly git
 * operations requiring an askpass script) and with a token to use in the
 * trampoline server.
 * It will handle saving SSH key passphrases when needed if the git operation
 * succeeds.
 *
 * @param fn        Function to invoke with all the necessary environment
 *                  variables.
 */
export async function withTrampolineEnv<T>(
  fn: (env: object) => Promise<T>
): Promise<T> {
  const sshEnv = await getSSHEnvironment()

  return withTrampolineToken(async token => {
    // The code below assumes a few things in order to manage SSH key passphrases
    // correctly:
    // 1. `withTrampolineEnv` is only used in the functions `git` (core.ts) and
    //    `spawnAndComplete` (spawn.ts)
    // 2. Those two functions always thrown an error when something went wrong,
    //    and just return a result when everything went fine.
    //
    // With those two premises in mind, we can safely assume that right after
    // `fn` has been invoked, we can store the SSH key passphrase for this git
    // operation if there was one pending to be stored.
    try {
      const result = await fn({
        DESKTOP_PORT: await trampolineServer.getPort(),
        DESKTOP_TRAMPOLINE_TOKEN: token,
        GIT_ASKPASS: getDesktopTrampolinePath(),
        DESKTOP_TRAMPOLINE_IDENTIFIER: TrampolineCommandIdentifier.AskPass,
        ...(enableCustomGitUserAgent()
          ? { GIT_USER_AGENT: await GitUserAgent() }
          : {}),

        ...sshEnv,
      })

      await storePendingSSHSecret(token)

      return result
    } finally {
      removePendingSSHSecretToStore(token)
    }
  })
}

/** Returns the path of the desktop-trampoline binary. */
export function getDesktopTrampolinePath(): string {
  return Path.resolve(
    __dirname,
    'desktop-trampoline',
    getDesktopTrampolineFilename()
  )
}

/** Returns the path of the ssh-wrapper binary. */
export function getSSHWrapperPath(): string {
  return Path.resolve(__dirname, 'desktop-trampoline', 'ssh-wrapper')
}
