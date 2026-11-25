import { expect, test } from 'claude-code/testing'

import { STATE_COLOR, bandWords, stateColor, stateDim, stateSegments } from '../hooks/states'

const counts = (shipped = 0, yours = 0, doing = 0, ready = 0, blocked = 0, deferred = 0, umbrella = 0) => ({ shipped, umbrella, yours, doing, ready, blocked, deferred })

test('#209 the issue bar is drawn by state, in the order Completed, Waiting for you, In progress, Ready, Blocked, Deferred', () => {
  const cells = stateSegments(counts(4, 1, 3, 2, 6, 1), 17, 17)
  expect(cells.map(one => one.id)).toEqual(['shipped', 'yours', 'doing', 'ready', 'blocked', 'deferred'])
  expect(cells.map(one => one.cells)).toEqual([4, 1, 3, 2, 6, 1])
})

test('#209 cells are shared by count, an empty state draws nothing and the rest of the width stays plain track', () => {
  expect(stateSegments(counts(2, 0, 2), 8, 8).map(one => [one.id, one.cells])).toEqual([['shipped', 2], ['doing', 2]])
  // 3 of 10 issues in a section: 3 of 10 cells, the remaining 7 are track.
  expect(stateSegments(counts(1, 1, 1), 10, 10).reduce((sum, one) => sum + one.cells, 0)).toBe(3)
  expect(stateSegments(counts(), 0, 10)).toEqual([])
})

test('#209 a small state keeps one cell and the bar never exceeds its width', () => {
  const cells = stateSegments(counts(30, 0, 0, 0, 1), 31, 10)
  expect(cells.find(one => one.id === 'blocked')?.cells).toBe(1)
  expect(cells.reduce((sum, one) => sum + one.cells, 0)).toBeLessThanOrEqual(10)
})

test('#209 the legacy umbrella section sits next to Waiting for you and is never green', () => {
  const cells = stateSegments(counts(1, 1, 0, 0, 0, 0, 1), 3, 9)
  expect(cells.map(one => one.id)).toEqual(['shipped', 'umbrella', 'yours'])
  expect(stateColor('umbrella')).not.toBe(stateColor('shipped'))
  expect(stateColor('umbrella')).toBe('suggestion')
})

test('#209 each state has its own look: open work blue (Ready the dim blue), Completed green, Blocked red, Deferred dim and uncoloured', () => {
  expect(stateColor('yours')).toBe('permission')
  expect(stateColor('doing')).toBe('suggestion')
  expect(stateColor('ready')).toBe('suggestion')
  expect(stateDim('ready')).toBe(true)
  expect(stateDim('doing')).toBe(false)
  expect(stateDim('deferred')).toBe(true)
  expect(STATE_COLOR.shipped).toBe('success')
  expect(stateColor('shipped')).toBe('success')
  expect(stateColor('blocked')).toBe('error')
  expect(stateColor('deferred')).toBeUndefined()
})

test('#209 the band counts words in the bar order, Deferred included, empty states left out, Waiting for you not among them', () => {
  const words = bandWords(counts(3, 2, 1, 4, 5, 6, 7))
  expect(words.map(one => [one.id, one.n, one.label])).toEqual([
    ['shipped', 3, 'complete'],
    ['umbrella', 7, 'in umbrella'],
    ['doing', 1, 'in progress'],
    ['ready', 4, 'ready'],
    ['blocked', 5, 'blocked'],
    ['deferred', 6, 'deferred'],
  ])
  expect(bandWords(counts(0, 2)).length).toBe(0)
})
