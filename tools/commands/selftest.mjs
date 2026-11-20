import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {HOME, DSH_HOME, configPath} from '../lib/paths.mjs'
import {NODE_EXE} from '../lib/nodebin.mjs'
import {config} from '../lib/config.mjs'
import {expressionPrompt} from '../lib/expression.mjs'
import {lifeConfig} from '../lib/life-config.mjs'
import {lifeStore} from '../lib/life-runtime.mjs'

if(process.argv.includes('--docs')){
  const spec=JSON.parse(fs.readFileSync(new URL('../prompts/expression-v1.json',import.meta.url),'utf8'))
  const scenes=['private-recommendation','public-comment','reply','private-reply']
  if(spec.version!==1||scenes.some(k=>!expressionPrompt(k))||!spec.modes.direct||!spec.modes['cat-draft'])throw Error('表达提示契约损坏')
  for(const file of ['life.mjs','comment.mjs','dm.mjs','corpus.mjs'])if(!fs.existsSync(new URL(file,import.meta.url)))throw Error('缺少命令 '+file)
  const seed=JSON.parse(fs.readFileSync(new URL('../corpus/seed-v1.json',import.meta.url),'utf8'))
  if(!Array.isArray(seed.entries)||seed.entries.some(e=>!e.text||!e.source||!/^[a-f0-9]{64}$/.test(e.source.sha256)||!Number.isInteger(e.source.recordIndex))||new Set(seed.entries.map(e=>e.id)).size!==seed.entries.length)throw Error('内置语料来源契约损坏')
  console.log('表达提示 v1：4 场景、2 草稿方式、life/comment/dm/corpus 入口及 '+seed.entries.length+' 条写法参考来源检查通过');process.exit(0)
}

const OK = '✓'
const NO = '✗'
const WARN = '!'
let failures = 0

function line(mark, label, detail) {
  if (mark === NO) failures++
  console.log(`  ${mark} ${label} — ${detail}`)
}

const pkgVersion=(()=>{try{return JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version??'?'}catch{return '?'}})()
console.log('DSH B 站鲸鱼插件 '+pkgVersion+' · 启动检查')
let current
try {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('invalid config')
  current = config()
  lifeConfig(current.life)
  line(OK, '配置文件', configPath)
  line(current.self?.mid ? OK : NO, 'B 站账号', current.self?.mid ?? '请在「角色与账号」扫码登录')
  line(current.owner?.mid ? OK : NO, '主人 UID', current.owner?.mid ?? '请在「角色与账号」填写主人 UID')
} catch {
  line(NO, '配置文件', configPath + '（缺失或不合法，请检查「设置 → 养鱼」）')
}
line(fs.existsSync(DSH_HOME) ? OK : NO, '目录 DSH_HOME', DSH_HOME)

try {
  const result = spawnSync(NODE_EXE, [fileURLToPath(new URL('./deps.mjs', import.meta.url)), '--json'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  })
  if (result.error || ![0, 3].includes(result.status)) throw Error('deps failed')
  const {items} = JSON.parse(result.stdout)
  for (const item of items) {
    const optional = item.name.startsWith('ffmpeg')
    line(item.ok ? OK : optional ? WARN : NO, item.name, item.detail || item.fix || '请查看依赖体检')
    if (!item.ok && item.fix) console.log('    ' + item.fix)
  }
} catch {
  line(NO, '依赖体检', '无法读取结果，请检查 DSH_NODE 或运行 node tools/bili.mjs deps')
}

if (current?.self?.mid && current.owner?.mid) {
  try {
    const diary = lifeStore(current).diaryStatus()
    const push = current.diary?.push !== false && current.notify?.type && current.notify.type !== 'none'
    line(OK, '自动日记', diary.enabled ? '已启用' : '已暂停或关闭')
    line(OK, '公开日记推送', push ? `渠道 ${current.notify.type}，最近结果 ${diary.lastPush?.status ?? '暂无'}` : '已关闭或未配置通知渠道')
    console.log('    公开日记 ' + diary.paths.public)
    console.log('    私人日记 ' + diary.paths.private)
  } catch {
    line(NO, '日记状态', '无法读取，请运行 node tools/bili.mjs life diary-status 查看')
  }
}

if (failures === 0) {
  try {
    fs.mkdirSync(path.join(HOME, '.bili-ai'), { recursive: true })
    fs.writeFileSync(path.join(HOME, '.bili-ai', 'selftest-passed.json'), JSON.stringify({ at: new Date().toISOString() }, null, 2))
  } catch {}
  console.log('✓ 启动检查通过')
} else {
  console.log(`✗ ${failures} 项需要处理。可在「运行与高级设置」查看调度状态。`)
}
process.exitCode = failures === 0 ? 0 : 1
