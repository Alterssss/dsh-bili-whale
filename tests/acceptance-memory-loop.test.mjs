// 最小记忆闭环验收（2026-10-30 主人给的需求）
//
// 目标：短期经历 → 长期理解 → 影响行为 → 后续经历强化/修正 → 无用细节遗忘
//
// 每个用例对应需求里的一条验收场景。用 store 内部 API 推进时间，不等真实七天。
// 这些用例【不调真实模型】—— 归纳候选由测试显式构造，验证的是机制能不能承接。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createLifeStore} from '../tools/lib/life-store.mjs'

const DAY = 86400000

function setup(t, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-loop-'))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  let at = Date.parse('2026-10-20T15:00:00Z')
  let seq = 0
  const store = createLifeStore({dshHome: home, account: '1', owner: '2', config, now: () => at})
  return {
    home,
    store,
    at: () => at,
    setAt: (ms) => { at = ms },
    advanceDays: (days) => { at += days * DAY },
    advanceHours: (h) => { at += h * 3600000 },
    receive: (text) => store.ingestOwnerMessage({actor: '2', messageId: String(++seq), text}),
  }
}

// 「主人在深夜反复表示疲惫，原因不确定」这条暂定理解
const tired = (events, extra = {}) => ({
  key: 'tired-late-night',
  subject: 'owner',
  type: 'understanding',
  text: '主人最近几晚都在深夜还醒着，并多次说累。原因不确定，不宜直接归因成熬夜习惯。',
  sourceIds: events.map((e) => e.id),
  quotes: events.map((e) => ({eventId: e.id, text: e.text})),
  scope: {scenes: ['private-reply', 'private-recommendation']},
  visibility: 'private',
  appliesTo: '深夜主人说累或还在聊',
  doThis: '少铺陈，允许推迟推荐，可以自然关心休息',
  falsifiedBy: '主人说明最近早睡、精神好，或否认疲惫时',
  alternatives: ['这几天事情多', '只是随口一说'],
  ...extra,
})

const accepted = (c) => ({
  key: c.key,
  action: 'accept',
  reason: '原话支持有限理解，保留不确定性',
  grounded: true,
  scopeClear: true,
  overgeneralized: false,
})

async function form(store, candidates, relations = []) {
  const job = await store.planFormation({force: true})
  await store.submitFormation(job.jobId, job.token, {candidates, relations, summary: '经历汇总'})
  const review = await store.claimReview()
  return store.commitFormation(review.jobId, review.token, {decisions: candidates.map(accepted)})
}

const memories = (store) => store.read().memories.filter((m) => m.active && m.status !== 'deleted')

// ─────────────────────────────────────────────────────────────
// 场景 1：第一晚说「我好累」—— 当前回复看得到，但不立即认定长期习惯
// ─────────────────────────────────────────────────────────────
test('场景1 第一晚的一句累：立刻进当前回复，但不当成长期习惯', async (t) => {
  const x = setup(t)
  await x.receive('我好累')

  // 立刻可见（不等待归纳）
  const ctx = x.store.context('累', 'private-reply')
  assert.match(ctx, /我好累/, '当前回复必须能看到这句话')

  // 但没有自动生成任何长期记忆
  assert.equal(memories(x.store).length, 0, '单次一句累不能立刻变成长期理解')

  // 也没进公开场景
  assert.doesNotMatch(x.store.context('', 'public-comment'), /我好累/)
})

// ─────────────────────────────────────────────────────────────
// 场景 2：接下来五晚反复深夜说累 —— 更新同一条，不新建同义
// ─────────────────────────────────────────────────────────────
test('场景2 五晚反复疲惫：更新同一条理解，保留多日依据，不新建同义记忆', async (t) => {
  const x = setup(t)
  const seen = []
  for (let i = 0; i < 5; i++) {
    x.advanceDays(1)
    x.setAt(x.at() - (x.at() % DAY) + 22 * 3600000) // 每天 22:00
    seen.push(await x.receive(`第${i + 1}晚还是好累`))
  }

  await form(x.store, [tired(seen)])
  const first = memories(x.store)
  assert.equal(first.length, 1, '第一轮应形成一条理解')
  const id = first[0].id
  assert.ok(first[0].independentDays >= 1)

  // 后面两晚的新经历：带 baseId/baseVersion 替换同一条
  // （version 每轮都会涨，必须每轮重新读，不能复用第一轮的）
  for (let round = 0; round < 2; round++) {
    x.advanceDays(1)
    x.setAt(x.at() - (x.at() % DAY) + 22 * 3600000)
    const cur = memories(x.store)[0]
    const e = await x.receive(`又一天，还是累`)
    // 小批次只携带最近四条背景；引用实际可见的近期来源。
    await form(x.store, [tired([e, seen.at(-1)], {baseId: cur.id, baseVersion: cur.version})])
  }

  const after = memories(x.store)
  assert.equal(after.length, 1, '反复出现不能堆成多条同义记忆')
  assert.ok((after[0].sourceIds ?? []).length >= 2, '更新后应保留多日依据')
})

// ─────────────────────────────────────────────────────────────
// 场景 3：第七晚继续聊 —— 相关理解进入回复上下文
// ─────────────────────────────────────────────────────────────
test('场景3 第七晚深夜：相关理解能进回复上下文', async (t) => {
  const x = setup(t)
  const seen = []
  for (let i = 0; i < 5; i++) {
    x.advanceDays(1)
    x.setAt(x.at() - (x.at() % DAY) + 22 * 3600000)
    seen.push(await x.receive(`第${i + 1}晚还是好累`))
  }
  await form(x.store, [tired(seen)])
  assert.equal(memories(x.store).length, 1)

  x.advanceDays(1)
  x.setAt(x.at() - (x.at() % DAY) + 23 * 3600000)
  await x.receive('还没睡')

  const ctx = x.store.context('累 睡', 'private-reply')
  // 上下文里要能看到这条理解的行为建议，而不只是原文
  assert.match(ctx, /少铺陈|推迟推荐|关心休息/, '理解必须参与行为选择，不只是存档')
})

// ─────────────────────────────────────────────────────────────
// 场景 4：同晚再次聊天 —— 近期提醒仍可见，不机械重复
// ─────────────────────────────────────────────────────────────
test('场景4 同晚再聊：近期提醒可见，且不会重复堆同一条', async (t) => {
  const x = setup(t)
  const seen = []
  for (let i = 0; i < 5; i++) {
    x.advanceDays(1)
    x.setAt(x.at() - (x.at() % DAY) + 22 * 3600000)
    seen.push(await x.receive(`第${i + 1}晚还是好累`))
  }
  await form(x.store, [tired(seen)])

  x.advanceDays(1)
  x.setAt(x.at() - (x.at() % DAY) + 23 * 3600000)
  await x.receive('还没睡')
  x.advanceHours(1)
  await x.receive('刚才你说了，我知道')

  const ctx = x.store.context('睡', 'private-reply')
  // 同一条理解在同一次上下文里不能出现两遍
  const hits = ctx.split('tired-late-night').length - 1
  assert.ok(hits <= 1, `同一条理解在一次上下文里最多出现一次（实际 ${hits} 次）`)
  // 但「刚提醒过」这件事要可见（近期的出站消息在上下文里）
  assert.match(ctx, /刚才你说了|还没睡/, '近期对话要可见，才不会机械重复')
})

// ─────────────────────────────────────────────────────────────
// 场景 5：主人说「最近早睡了」—— 更新旧理解，不再当当前习惯
// ─────────────────────────────────────────────────────────────
test('场景5 主人否认熬夜：旧理解被修正，不再作为当前状态召回', async (t) => {
  const x = setup(t)
  const seen = []
  for (let i = 0; i < 5; i++) {
    x.advanceDays(1)
    x.setAt(x.at() - (x.at() % DAY) + 22 * 3600000)
    seen.push(await x.receive(`第${i + 1}晚还是好累`))
  }
  await form(x.store, [tired(seen)])
  const old = memories(x.store)[0]

  x.advanceDays(2)
  const good = await x.receive('最近早睡了，精神好多了')

  // 修正：用 baseId 替换，并且把 falsifiedBy 落实
  await form(x.store, [
    tired([good], {
      baseId: old.id,
      baseVersion: old.version,
      text: '主人前几晚深夜疲惫，后来自己说改为早睡、精神好了。之前的疲惫不再作为当前状态。',
      appliesTo: '主人自己提到睡眠变化时',
      doThis: '不再按「最近熬夜疲惫」判断，按主人当前说法来',
      falsifiedBy: '主人又说睡不好或很累时',
    }),
  ])

  const now = memories(x.store)
  assert.equal(now.length, 1, '修正后应仍是一条，不是叠加两条')
  assert.doesNotMatch(now[0].text, /仍然|一直在熬夜/, '不能继续把熬夜当当前习惯')

  const ctx = x.store.context('累 睡', 'private-reply')
  assert.doesNotMatch(ctx, /不适合直接归因成熬夜习惯|多次说累。原因不确定/, '旧结论不应继续作为当前判断出现')
})

// ─────────────────────────────────────────────────────────────
// 场景 6：大量普通寒暄过期 —— 短期被清理，长期理解与代表依据仍可读
// ─────────────────────────────────────────────────────────────
test('场景6 寒暄过期：短期记录真的被清理，长期理解与代表原句仍可读', async (t) => {
  const x = setup(t)
  const keep = await x.receive('我好累')
  for (let i = 0; i < 40; i++) {
    x.advanceHours(3)
    await x.receive(`随便说说 ${i}`)
  }
  await form(x.store, [tired([keep])])
  assert.equal(memories(x.store).length, 1)

  const before = x.store.read()
  const beforeEvents = before.events.length
  const beforeExchanges = before.cognition?.working?.exchanges?.length ?? 0
  assert.ok(beforeEvents > 10 && beforeExchanges > 0)

  // 推进 30 天，跑维护
  x.advanceDays(30)
  await x.store.maintainCognition()

  const after = x.store.read()
  const afterEvents = after.events.length
  const afterExchanges = after.cognition?.working?.exchanges?.length ?? 0

  // 短期确实被清掉了
  assert.ok(afterExchanges < beforeExchanges, `近期的对话窗口应被清理（${beforeExchanges} → ${afterExchanges}）`)
  assert.ok(afterEvents < beforeEvents, `过期事件应被清理，不能只堆着（${beforeEvents} → ${afterEvents}）`)

  // 但长期理解还在，而且代表原句还读得到
  const ms = memories(x.store)
  assert.equal(ms.length, 1, '长期理解不能因为清理而丢失')
  const q = (ms[0].quotes ?? [])[0]
  assert.ok(q, '应保留代表原句')
  const stillThere = after.events.some((e) => e.id === q.eventId)
  assert.ok(stillThere, '代表原句的来源事件不能在被引用时删掉')
})

// ─────────────────────────────────────────────────────────────
// 场景 8（主人 2026-10-30 追加）：多批次处理后，无经历被意外遗漏
//
// 旧实现 cursor = max(本批 seq)，而批次从最新往回取 → 中间的 seq 被整段跳过 ✗
// 这个用例把"批量远超单批容量"的情况跑到底，逐条核对每个学习类经历都进过某一批。
// ─────────────────────────────────────────────────────────────
test('场景8 多批次处理：每一条经历都进过某一批，cursor 只在连续消费后前进', async (t) => {
  const x = setup(t)
  const all = []
  for (let i = 0; i < 120; i++) {
    x.advanceHours(1)
    all.push(await x.receive(`第 ${i} 句日常`))
  }
  const learningIds = new Set(all.map((e) => e.id))
  const covered = new Set()
  let rounds = 0

  for (; rounds < 20; rounds++) {
    const job = await x.store.planFormation({force: true})
    if (!job) break
    const batch = (job.input?.events ?? []).filter((e) => learningIds.has(e.id))
    assert.ok(batch.length > 0, '批次里必须至少有一条学习类经历')
    for (const e of batch) covered.add(e.id)

    // 空批次提交（这里只验覆盖，不验内容）
    await x.store.submitFormation(job.jobId, job.token, {candidates: [], relations: [], summary: '本轮无值得长期保留的'})
    const review = await x.store.claimReview()
    await x.store.commitFormation(review.jobId, review.token, {decisions: []})

    // 不变量：cursor 越过的那段必须是"连续被消费过"的，不能跳过未覆盖的
    const state = x.store.read()
    const cursor = state.cognition?.cursor ?? 0
    const bySeq = new Map(all.map((e) => [e.seq, e.id]))
    for (const [seq, id] of bySeq) {
      if (seq > cursor) continue
      assert.ok(covered.has(id), `seq ${seq} 已被 cursor 越过，却没进过任何批次 ✗`)
    }
  }

  assert.ok(rounds >= 2, '批量应跨多批处理（否则没验到跳读）')
  const missed = [...learningIds].filter((id) => !covered.has(id))
  assert.equal(missed.length, 0, `有 ${missed.length} 条经历从未进过任何批次 ✗`)

  // 全部覆盖后，cursor 应该追上最后一条
  const maxSeq = Math.max(...all.map((e) => e.seq))
  const finalCursor = x.store.read().cognition?.cursor ?? 0
  assert.equal(finalCursor, maxSeq, `全部消费完后 cursor 应等于最后一条 seq（实际 ${finalCursor} / ${maxSeq}）`)

  // 而且不会再有"可归纳"的残留
  assert.equal(await x.store.planFormation({force: true}), null, '全部消费完后不应再规划出新批次')
})

test('场景7 对内容的判断可被相反经历修正，并参与后续评价', async (t) => {
  const x = setup(t)
  // 一条看视频的经历
  const v1 = await x.store.record('video-read', {
    text: '某 UP 主：用一张图就能做出会动的虚拟人',
    target: 'BV1aa411c7aa',
  })
  const judgement = {
    key: 'ai-avatar-judge',
    subject: 'world',
    type: 'understanding',
    text: '这类「一张图做出会动的虚拟人」的视频，多半只是演示，实际门槛在绑定和口型。',
    sourceIds: [v1.id],
    quotes: [{eventId: v1.id, text: '一张图就能做出会动的虚拟人'}],
    scope: {scenes: ['public-comment', 'public-recommendation']},
    visibility: 'public',
    appliesTo: '评价 AI 虚拟人 / 立绘驱动类视频时',
    doThis: '先看有没有说明绑定流程和口型，再判断能不能用',
    falsifiedBy: '看到完整流程演示且可复现时',
    alternatives: ['可能只是剪辑省掉了过程'],
  }
  await form(x.store, [judgement])
  const first = memories(x.store).find((m) => m.type === 'understanding')
  assert.ok(first, '应形成一条关于内容的暂定判断')

  // 相反经历
  x.advanceDays(3)
  const v2 = await x.store.record('video-read', {
    text: '完整演示：从立绘拆层、绑骨到口型，全程未剪辑，附工程文件',
    target: 'BV1bb411c7bb',
  })
  await form(x.store, [
    {
      ...judgement,
      baseId: first.id,
      baseVersion: first.version,
      text: '这类视频多数只给演示，但也存在完整可复现的流程演示；不能只看标题就下判断。',
      sourceIds: [v2.id],
      quotes: [{eventId: v2.id, text: '全程未剪辑，附工程文件'}],
    },
  ])

  const ms = memories(x.store)
  assert.equal(ms.filter((m) => m.type === 'understanding').length, 1, '修正应更新同一条，不新建')
  assert.match(ms[0].text, /也存在完整可复现/, '修正后的判断要体现相反经历')

  // 后续评价要用到更新后的理解
  const ctx = x.store.context('虚拟人 立绘', 'public-comment')
  assert.match(ctx, /也存在完整可复现|不能只看标题/, '更新后的理解要能参与后续评价')
})
