import { describe, expect, test } from 'claude-code/testing'

import { isOwnerRequest } from '../hooks/web-control'
import { OWNER_REQUEST_TABLE } from './owner-request-cases'

describe('the shared owner-request table', () => {
  for (const one of OWNER_REQUEST_TABLE.cases) {
    test(`${one.accept ? 'accepts' : 'refuses'} ${one.name}`, () => {
      const request: Record<string, unknown> = { ...OWNER_REQUEST_TABLE.base, ...one.set }
      for (const key of one.drop ?? []) delete request[key]

      expect(isOwnerRequest(request)).toBe(one.accept)
    })
  }
})
