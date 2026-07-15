/**
 * Security-derived gateway coverage (13 §5, V-3): enumerate every route the
 * app actually registers and assert the auth gateway rejects unauthenticated
 * access — a missed route must fail THIS test, not an audit.
 */

import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApiHarness } from './apiHarness.js';

interface DiscoveredRoute {
  method: string;
  path: string;
}

/** Walks the Express 5 router stack for registered routes. */
function discoverRoutes(app: Express): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  interface Layer {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  }
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  const walk = (layers: Layer[]): void => {
    for (const layer of layers) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({ method: method.toUpperCase(), path: layer.route.path });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(stack);
  return routes;
}

describe('auth gateway coverage (13 §5)', () => {
  const { app } = makeApiHarness();
  const routes = discoverRoutes(app);

  it('discovers the full 08 §1 surface (guard against silent additions)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(13);
    expect(routes).toContainEqual({ method: 'POST', path: '/api/projects' });
    expect(routes).toContainEqual({ method: 'POST', path: '/api/runs/:id/cancel' });
    expect(routes).toContainEqual({ method: 'GET', path: '/api/conversations/:id/events' });
  });

  const unauthExempt = new Set(['GET /api/health']);

  for (const route of discoverRoutes(makeApiHarness().app)) {
    const key = `${route.method} ${route.path}`;
    if (unauthExempt.has(key)) continue;
    it(`${key} rejects unauthenticated access with 401`, async () => {
      const path = route.path.replaceAll(/:(\w+)/g, 'x_$1');
      const res = await request(app)[
        route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'
      ](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
    });
  }

  it('a wrong token is rejected, not just a missing one', async () => {
    const res = await request(app)
      .get('/api/agents')
      .set({ Authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
  });
});
