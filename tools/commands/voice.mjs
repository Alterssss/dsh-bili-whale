import fs from 'node:fs'
import path from 'node:path'
import { HOME } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import {
  readVoice, buildVoiceBlock, loadExpressions, normalizeExpressions, buildLearnPrompt, DEFAULT_VOICE,
} from '../../lib/voice.js'

const EXP_FILE = path.join(HOME, '.bili-ai', 'expressions.json')
const args = process.argv.slice(2)   // bili.mjs 会把子命令原样透传：argv[2] = show/learn/import/check
const sub = args[0] || 'show'

if (config()?.dialogueMode === 'character') {
  console.log('人格与表达由养鱼的「角色」设置统一管理；旧 voice 和 persona.md 已停用。')
  process.exit(0)
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}

function readCfg() {
  try { return config() || {} } catch { return {} }
}

switch (sub) {
  case 'show': {
    const cfg = readCfg()
    const voice = readVoice(cfg)
    const exprs = loadExpressions(EXP_FILE)
    const block = buildVoiceBlock(
      voice,
      { expressions: exprs },
    )
    console.log('［配置来源］' + (process.env.BILI_WHALE_CONFIG || '默认'))
    console.log('［口癖库］' + EXP_FILE + '  ' + exprs.length + ' 条' + (fs.existsSync(EXP_FILE) ? '' : '（不存在）'))
    console.log('')
    if (!block) {
      console.log('（自然表达已关闭，不额外注入人格或口癖）')
      console.log('')
      console.log('打开「设置 → 养鱼 → 人格与表达」开启自然表达，或设置 voice.enabled = true。例如：')
      console.log(JSON.stringify({ voice: {
        enabled: true,
        personality: '是一条住在电脑里的鲸鱼，嘴比脑子快，什么都懂但经常算错',
        behaviorStyle: '话密，但不会为了填空硬找话题；被说菜会回一句，但不追着吵',
        replyStyle: '短句，一句话不超过两行；不用"呢哦呀"，用"啊吧算了"',
        multipleStyles: ['只回两个字', '只回一个标点', '像在自言自语'],
        styleMode: 'random',
        multipleProbability: 0.2,
        expressionTopK: 6,
      } }, null, 2))
      break
    }
    console.log(block)
    break
  }

  case 'learn': {
    const file = args[1]
    if (!file) die('用法: bili.mjs voice learn <语料文件>')
    if (!fs.existsSync(file)) die('找不到文件: ' + file)
    const corpus = fs.readFileSync(file, 'utf8')
    if (!corpus.trim()) die('文件是空的')
    const prompt = buildLearnPrompt(corpus, { maxChars: Number(args[2]) || 6000 })
    console.log(prompt)
    console.log('')
    console.log('---')
    console.log('把上面整段贴给模型，它应该返回 JSON 数组；然后：')
    console.log(`  node bili.mjs voice import <把返回的 JSON 存成文件>.json`)
    break
  }

  case 'import': {
    const file = args[1]
    if (!file) die('用法: bili.mjs voice import <json文件>')
    if (!fs.existsSync(file)) die('找不到文件: ' + file)
    let raw
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { die('JSON 解析失败: ' + e.message) }
    const next = normalizeExpressions(raw)
    if (next.items.length === 0) die('没有可用条目：' + (next.errors.join('; ') || '输入是空的'))
    const prev = loadExpressions(EXP_FILE)
    const merged = normalizeExpressions([...prev, ...next.items])
    fs.mkdirSync(path.dirname(EXP_FILE), { recursive: true })
    fs.writeFileSync(EXP_FILE, JSON.stringify({ expressions: merged.items }, null, 1) + '\n', 'utf8')
    console.log(`导入 ${next.items.length} 条（校验失败 ${next.errors.length} 条），合并后共 ${merged.items.length} 条`)
    console.log('写入: ' + EXP_FILE)
    if (next.errors.length) console.log('被跳过的：' + next.errors.slice(0, 5).join('; '))
    break
  }

  case 'check': {
    if (!fs.existsSync(EXP_FILE)) { console.log('口癖库不存在：' + EXP_FILE); break }
    let raw
    try { raw = JSON.parse(fs.readFileSync(EXP_FILE, 'utf8')) } catch (e) { die('JSON 解析失败: ' + e.message) }
    const n = normalizeExpressions(raw)
    console.log(`共 ${n.items.length} 条，校验失败 ${n.errors.length} 条`)
    for (const e of n.items.slice(0, 10)) console.log(`  · 当「${e.situation}」→「${e.style}」`)
    if (n.errors.length) console.log('问题：' + n.errors.slice(0, 8).join('; '))
    break
  }

  default:
    console.log('voice 子命令: show | learn <文件> | import <json> | check')
    console.log('默认 expressionTopK = ' + DEFAULT_VOICE.expressionTopK)
    process.exit(2)
}
