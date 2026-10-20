/**
 * 统一的路径解析（DSH home 与用户主目录）。
 *
 * 为什么需要它：插件宿主半边（lib/index.js）用的是
 *   process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
 * 而工具链（tools/ 下的脚本）此前各自硬编码 path.join(HOME, '.dsh')，
 * **完全不读 DSH_HOME**。两边的 home 语义一旦不一致就会分叉：
 *
 *   · DSH_HOME 被自定义（多个 profile 根、便携安装、CI）时，
 *     宿主把配置写进 $DSH_HOME/bili-whale.config.json，
 *     工具链却去 $HOME/.dsh/ 读 → 读不到（或读到另一份），
 *     生物钟、日记、日志、配置全部错位。
 *
 * 因此所有 tools/ 脚本都应从这里取路径，别再本地拼 '.dsh'。
 *
 * 注意保留旧行为：USERPROFILE 优先于 HOME，`BILI_WHALE_CONFIG` 仍可覆盖配置文件位置。
 */
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE，保持与原实现一致）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边 (lib/index.js) 完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** 拼一个位于 DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 拼一个位于用户主目录下的路径（.bili-ai 等凭据/状态目录用）。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（保留 BILI_WHALE_CONFIG 覆盖）。 */
export const configPath = process.env.BILI_WHALE_CONFIG || dshPath('bili-whale.config.json')
