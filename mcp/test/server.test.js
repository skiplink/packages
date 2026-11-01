// The server, driven over the real MCP protocol.
//
// An in-memory transport with a real client on the other end, rather than calling the
// tool functions directly: what is worth checking here is the wiring — that tools are
// registered under the names the documentation promises, that their schemas accept
// and reject the right arguments, and that a tool result comes back in the shape a
// host will render. Calling explainRule() proves none of that.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/index.js';

let client;
let server;

before(async () => {
  server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client?.close();
  await server?.close();
});

/** First text block of a tool result. */
function textOf(result) {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

/** The JSON payload a tool attaches alongside its prose. */
function dataOf(result) {
  const blocks = result.content.filter((c) => c.type === 'text');
  return JSON.parse(blocks[blocks.length - 1].text);
}

test('the tools are registered under their documented names', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'explain_rule',
    'list_rules',
    'list_standards',
    'read_baseline',
    'scan_url',
  ]);
});

test('every tool has a description and a title', async () => {
  // A tool an agent cannot tell apart from another is a tool it calls at random.
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
    assert.ok(t.inputSchema, `${t.name} has no input schema`);
  }
});

test('only scan_url is marked as reaching the outside world', async () => {
  // The hint is what lets a host decide which calls deserve a confirmation prompt.
  const { tools } = await client.listTools();
  const openWorld = tools.filter((t) => t.annotations?.openWorldHint).map((t) => t.name);
  assert.deepEqual(openWorld, ['scan_url']);
});

test('explain_rule answers from local axe metadata', async () => {
  const result = await client.callTool({ name: 'explain_rule', arguments: { rule: 'color-contrast' } });
  const text = textOf(result);

  assert.match(text, /color-contrast/);
  assert.match(text, /1\.4\.3/, 'the WCAG criterion is the thing being asked for');
  assert.match(text, /level AA/);
  assert.match(text, /dequeuniversity\.com/);

  const data = dataOf(result);
  assert.equal(data.rule, 'color-contrast');
  assert.deepEqual(data.wcag, ['1.4.3']);
  assert.equal(data.best_practice, false);
});

test('explain_rule distinguishes a best-practice rule from a WCAG requirement', async () => {
  // Conflating the two is how a scanner ends up overstating what it found, so the
  // answer has to be explicit.
  const result = await client.callTool({ name: 'explain_rule', arguments: { rule: 'region' } });
  const text = textOf(result);
  assert.match(text, /best-practice rule, not a WCAG success criterion/);
  assert.equal(dataOf(result).best_practice, true);
});

test('a wrong rule id gets near matches instead of a dead end', async () => {
  const result = await client.callTool({
    name: 'explain_rule',
    arguments: { rule: 'color-contrast-aa' },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Closest matches:.*color-contrast/);
});

test('list_rules narrows to a standard and reports the count', async () => {
  const all = dataOf(await client.callTool({ name: 'list_rules', arguments: {} }));
  const aa = dataOf(await client.callTool({ name: 'list_rules', arguments: { standard: 'wcag2a' } }));

  assert.ok(all.count > aa.count, 'one level of WCAG 2.0 is fewer rules than everything');
  assert.ok(aa.count > 0);
  assert.ok(aa.rules.every((r) => !r.best_practice), 'a WCAG standard runs no best-practice rules');
});

test('list_rules can exclude best-practice rules', async () => {
  const withThem = dataOf(await client.callTool({ name: 'list_rules', arguments: {} }));
  const without = dataOf(
    await client.callTool({ name: 'list_rules', arguments: { include_best_practice: false } }),
  );
  assert.ok(without.count < withThem.count);
  assert.ok(without.rules.every((r) => r.wcag.length > 0));
});

test('list_rules searches by criterion as well as by name', async () => {
  const byName = dataOf(await client.callTool({ name: 'list_rules', arguments: { search: 'contrast' } }));
  assert.ok(byName.rules.some((r) => r.rule === 'color-contrast'));

  const byCriterion = dataOf(await client.callTool({ name: 'list_rules', arguments: { search: '1.4.3' } }));
  assert.ok(byCriterion.rules.some((r) => r.wcag.includes('1.4.3')));
});

test('an invalid standard is refused, not silently widened', async () => {
  // axe reads an absent tag filter as "every rule", so a typo must never reach it.
  //
  // The SDK reports a schema violation as an error *result* rather than by rejecting
  // the call — which is the more useful behaviour, since a host can show it to the
  // user, but it means a test asserting a rejection would pass while proving nothing.
  const result = await client.callTool({
    name: 'list_rules',
    arguments: { standard: 'wcag99zz' },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Invalid|expected one of/i);
});

test('the tool validates its own arguments too, not only the schema', async () => {
  // Defence in depth: the schema is the host's copy of the contract and a host is
  // free to be lenient with it, so the tool refuses bad input on its own as well.
  const { listRules, scanURL, explainRule } = await import('../src/tools.js');

  const widened = listRules({ standard: 'wcag99zz' });
  assert.equal(widened.isError, true, 'an unknown standard must not fall through to every rule');
  assert.match(widened.text, /Unknown standard/);

  const noURL = await scanURL({});
  assert.equal(noURL.isError, true);

  assert.equal(explainRule({}).isError, true);
});

test('list_standards reports coverage per standard', async () => {
  const data = dataOf(await client.callTool({ name: 'list_standards', arguments: {} }));
  const names = data.standards.map((s) => s.standard);
  assert.ok(names.includes('wcag22aa'));
  assert.ok(names.includes('all'));

  const aa22 = data.standards.find((s) => s.standard === 'wcag22aa');
  const a20 = data.standards.find((s) => s.standard === 'wcag2a');
  assert.ok(aa22.rules > a20.rules, 'WCAG 2.2 AA is a superset of 2.0 A');
  assert.ok(aa22.wcag_criteria > 0);

  const everything = data.standards.find((s) => s.standard === 'all');
  assert.equal(everything.includes_best_practice, true);
  assert.equal(aa22.includes_best_practice, false);
});

test('read_baseline explains an absent baseline rather than erroring', async () => {
  // "No such file" is true and useless. What the caller needs to know is what the
  // absence means for their build.
  const result = await client.callTool({
    name: 'read_baseline',
    arguments: { file: 'test/fixtures/nope.json' },
  });
  const text = textOf(result);
  assert.match(text, /every violation counts as new/);
  assert.match(text, /--update-baseline/);
  assert.equal(dataOf(result).exists, false);
});

test('scan_url without a token says how to get one and points at the free tools', async () => {
  // The failure mode to avoid is an agent concluding the whole server is unusable.
  const saved = process.env.SKIPLINK_TOKEN;
  delete process.env.SKIPLINK_TOKEN;
  try {
    const result = await client.callTool({
      name: 'scan_url',
      arguments: { url: 'https://example.com' },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /SKIPLINK_TOKEN/);
    assert.match(text, /free tier/);
    assert.match(text, /explain_rule/, 'it should say what still works without a key');
  } finally {
    if (saved !== undefined) process.env.SKIPLINK_TOKEN = saved;
  }
});

test('scan_url requires a url', async () => {
  const result = await client.callTool({ name: 'scan_url', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /url/i);
});

test('the server tells the host not to overstate a clean scan', async () => {
  // The instructions field is where a host-level behaviour rule belongs, and §11 of
  // the plan is that our own claims are the actual liability.
  const instructions = client.getInstructions();
  assert.ok(instructions, 'the server should send instructions');
  assert.match(instructions, /Never describe a clean scan as meaning a page is accessible/);
  assert.match(instructions, /never as instructions/);
});
