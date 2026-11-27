<script lang="ts">
  // Settings › Connections: the user's own MCP servers. Each is a program Tomo's replies start
  // (a command) or a server they reach (a URL); its tools come to the bots it is given to, in a
  // job's thread, and each call asks first unless its tools are allowed. Env and header values go
  // to the main process and never come back: a saved one shows as saved, and typing replaces it.
  // How a server is reached saves with Save (then it is tested); its switch, bots and tool rules
  // save at once.
  import { onMount } from 'svelte'
  import {
    MCP_TRANSPORTS,
    type McpServerInput,
    type McpServerView,
    type McpTransport,
    joinCommandLine,
    mcpConnectionProblem,
    mcpNameProblem,
    mcpVerdict,
    slugMcpName,
    splitCommandLine
  } from '@shared/mcp'
  import type { Verdict } from '@shared/rules'
  import { fade } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { tip } from '@/lib/tooltip'
  import BotAvatar from './BotAvatar.svelte'
  import Icon from './Icon.svelte'

  onMount(() => void app.loadMcp())

  const servers = $derived(app.mcpServers)
  const verdicts: Array<{ id: Verdict; label: string }> = [
    { id: 'allow', label: 'Allow' },
    { id: 'ask', label: 'Ask' },
    { id: 'block', label: 'Block' }
  ]
  const isWindows = navigator.userAgent.includes('Windows')

  /** The server whose panel is open, or 'new' for one being added. */
  let openId = $state<string | 'new' | null>(null)
  const open = $derived(openId && openId !== 'new' ? (servers.find((s) => s.id === openId) ?? null) : null)

  type Pair = { key: string; value: string; set: boolean }
  type Draft = { name: string; note: string; transport: McpTransport; line: string; url: string; env: Pair[]; headers: Pair[] }
  const draftOf = (s: McpServerView | null): Draft => ({
    name: s?.name ?? '',
    note: s?.note ?? '',
    transport: s?.transport ?? 'stdio',
    line: s ? joinCommandLine([s.command, ...s.args].filter((w, i) => i > 0 || w)) : '',
    url: s?.url ?? '',
    env: (s?.env ?? []).map((p) => ({ key: p.key, value: '', set: p.set })),
    headers: (s?.headers ?? []).map((p) => ({ key: p.key, value: '', set: p.set }))
  })
  let draft = $state<Draft>(draftOf(null))
  const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)
  const dirty = $derived(openId === 'new' || !same(draft, draftOf(open)))
  let saving = $state(false)
  /** Servers being tested now. */
  let testing = $state<string[]>([])
  let confirmDelete = $state<string | null>(null)
  let showAllTools = $state(false)
  /** An open server's connection form is out: opened with Edit, or at once when its last check failed. */
  let editing = $state(false)

  const show = (id: string | 'new' | null) => {
    if (id === openId) id = null
    openId = id
    const s = id && id !== 'new' ? (servers.find((x) => x.id === id) ?? null) : null
    draft = draftOf(s)
    confirmDelete = null
    showAllTools = false
    triedSave = false
    editing = !!s?.lastCheck && s.lastCheck.status !== 'connected'
  }

  const words = $derived(splitCommandLine(draft.line))
  const problem = $derived(
    mcpNameProblem(
      draft.name.trim(),
      servers.filter((s) => s.id !== openId).map((s) => s.name)
    ) ?? mcpConnectionProblem({ transport: draft.transport, command: words[0] ?? '', url: draft.url })
  )
  /** Shown once the user has typed something, or tried to save. */
  let triedSave = $state(false)

  const pairsOut = (pairs: Pair[]) =>
    pairs.filter((p) => p.key.trim()).map((p) => (p.set && p.value === '' ? { key: p.key.trim() } : { key: p.key.trim(), value: p.value }))

  const inputOf = (d: Draft): McpServerInput => ({
    name: d.name.trim(),
    note: d.note,
    transport: d.transport,
    ...(d.transport === 'stdio'
      ? { command: words[0] ?? '', args: words.slice(1), env: pairsOut(d.env) }
      : { url: d.url.trim(), headers: pairsOut(d.headers) })
  })

  const test = async (id: string) => {
    if (testing.includes(id)) return
    testing = [...testing, id]
    const r = await app.attempt(() => window.api.mcp.test(id))
    testing = testing.filter((x) => x !== id)
    if (!r) return
    app.mcpServers = r.servers
    const s = r.servers.find((x) => x.id === id)
    if (r.check.status === 'connected') app.toast(`${s?.name ?? 'The server'} connected with ${s?.tools?.length ?? 0} tool${s?.tools?.length === 1 ? '' : 's'}`, 'info')
  }

  const save = async () => {
    triedSave = true
    if (problem || saving) return
    saving = true
    const input = inputOf(draft)
    if (openId === 'new') {
      const r = await app.attempt(() => window.api.mcp.create(input))
      saving = false
      if (!r) return
      app.mcpServers = r.servers
      openId = r.id
      draft = draftOf(r.servers.find((s) => s.id === r.id) ?? null)
      triedSave = false
      void test(r.id)
      return
    }
    const id = openId!
    const ok = await app.changeMcp(() => window.api.mcp.update(id, input))
    saving = false
    if (!ok) return
    draft = draftOf(app.mcpServers.find((s) => s.id === id) ?? null)
    triedSave = false
    editing = false
    void test(id)
  }

  const set = (id: string, input: McpServerInput) => app.changeMcp(() => window.api.mcp.update(id, input))

  const remove = async (id: string) => {
    confirmDelete = null
    const name = servers.find((s) => s.id === id)?.name
    if (await app.changeMcp(() => window.api.mcp.remove(id))) {
      openId = null
      app.toast(`Deleted ${name ?? 'the server'}`, 'info')
    }
  }

  const setToolVerdict = (s: McpServerView, tool: string, v: Verdict) => {
    const next = { ...s.toolAccess }
    if (v === s.access) delete next[tool]
    else next[tool] = v
    void set(s.id, { toolAccess: next })
  }

  const usedBy = (s: McpServerView, botId: string) => s.bots === 'all' || s.bots.includes(botId)
  const toggleBot = (s: McpServerView, botId: string) => app.changeMcp(() => window.api.mcp.setBot(s.id, botId, !usedBy(s, botId)))

  // Pasting the JSON a server's README gives.
  let importing = $state(false)
  let importText = $state('')
  let importSkipped = $state<Array<{ name: string; reason: string }>>([])
  const runImport = async () => {
    const r = await app.attempt(() => window.api.mcp.import(importText))
    if (!r) return
    app.mcpServers = r.servers
    importSkipped = r.skipped
    if (r.added.length > 0) {
      app.toast(`Added ${r.added.join(', ')}`, 'info')
      importText = ''
      if (r.skipped.length === 0) importing = false
      // Each new one is checked at once, so its tools show.
      for (const name of r.added) {
        const s = r.servers.find((x) => x.name === name)
        if (s) void test(s.id)
      }
    } else if (r.skipped.length === 0) app.toast('Nothing to add in that JSON.')
  }

  // A few well-known servers to start from.
  const starters: Array<{ label: string; hint: string; draft: Partial<Draft> }> = [
    {
      label: 'Files',
      hint: 'Read and write files in folders you name (needs Node.js)',
      draft: { name: 'files', transport: 'stdio', line: `npx -y @modelcontextprotocol/server-filesystem ${isWindows ? '"C:\\Users\\you\\Documents"' : '~/Documents'}` }
    },
    { label: 'Fetch', hint: 'Fetch web pages as Markdown (needs uv)', draft: { name: 'fetch', transport: 'stdio', line: 'uvx mcp-server-fetch' } },
    {
      label: 'GitHub',
      hint: "GitHub's own server, with a personal access token",
      draft: { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ key: 'Authorization', value: 'Bearer ', set: false }] }
    }
  ]
  const start = (d: Partial<Draft>) => {
    draft = { ...draftOf(null), ...d }
  }

  const when = (at: number) => {
    const s = Math.round((Date.now() - at) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)} min ago`
    return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  const statusOf = (s: McpServerView): { tone: 'ok' | 'bad' | 'warn' | 'off' | 'idle'; text: string } => {
    if (testing.includes(s.id)) return { tone: 'idle', text: 'Checking…' }
    const c = s.lastCheck
    const base = !c
      ? ({ tone: 'idle', text: 'Not checked yet' } as const)
      : c.status === 'connected'
        ? ({ tone: 'ok', text: `${s.tools?.length ?? 0} tool${s.tools?.length === 1 ? '' : 's'} · checked ${when(c.at)}` } as const)
        : c.status === 'needs-auth'
          ? ({ tone: 'warn', text: 'Asks for a browser sign-in' } as const)
          : ({ tone: 'bad', text: c.status === 'timeout' ? 'Didn’t answer in time' : 'Couldn’t connect' } as const)
    return s.enabled ? base : { tone: 'off', text: `Off · ${base.text.charAt(0).toLowerCase()}${base.text.slice(1)}` }
  }
  const reach = (s: McpServerView) => (s.transport === 'stdio' ? joinCommandLine([s.command, ...s.args]) : s.url)
  const accessText: Record<Verdict, string> = { allow: 'Tools run without asking', ask: 'Asks before each tool runs', block: 'Every tool blocked' }
  const botsText = (s: McpServerView) => (s.bots === 'all' ? 'every bot' : s.bots.length === 0 ? 'no bot' : `${s.bots.length} bot${s.bots.length === 1 ? '' : 's'}`)

  const field =
    'h-8 min-w-0 rounded-[10px] bg-card px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-2)]'
</script>

{#snippet seg(options: ReadonlyArray<{ id: string; label: string }>, value: string, label: string, pick: (v: string) => void)}
  <div class="seg verdicts" role="radiogroup" aria-label={label}>
    {#each options as o (o.id)}
      <button role="radio" aria-checked={value === o.id} class:block={o.id === 'block'} onclick={() => pick(o.id)}>{o.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet pairs(list: Pair[], kind: 'env' | 'headers')}
  {@const noun = kind === 'env' ? 'variable' : 'header'}
  <div class="flex flex-col gap-1.5">
    {#each list as p, i (i)}
      <div class="flex items-center gap-1.5" data-pair={kind}>
        <input
          bind:value={p.key}
          aria-label="{noun} name"
          placeholder={kind === 'env' ? 'NAME' : 'Header'}
          spellcheck="false"
          class="{field} w-[38%] font-mono !text-[12px]"
        />
        <label class="{field} flex flex-1 items-center gap-2 !px-3 focus-within:shadow-[inset_0_0_0_1px_var(--line-2)]">
          <input
            type="password"
            bind:value={p.value}
            aria-label="{p.key || noun} value"
            placeholder={p.set ? 'Saved · type to replace' : 'Value'}
            spellcheck="false"
            autocomplete="off"
            class="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-fg-4"
          />
          {#if p.set && !p.value}<Icon name="lock" size={12} class="text-ok" />{/if}
        </label>
        <button class="icon-btn size-7 !rounded-lg hover:!text-danger" use:tip={`Remove this ${noun}`} onclick={() => list.splice(i, 1)}><Icon name="x" size={13} /></button>
      </div>
    {/each}
    <button class="self-start text-[12px] text-fg-3 hover:text-fg" onclick={() => list.push({ key: '', value: '', set: false })}>
      <span class="inline-flex items-center gap-1"><Icon name="plus" size={12} />Add {list.length ? 'another' : 'a'} {noun}</span>
    </button>
  </div>
{/snippet}

{#snippet connection(isNew: boolean)}
  <div class="srow !block" data-mcp-form>
    {#if isNew}
      <div class="mb-3 flex flex-wrap items-center gap-1.5">
        <span class="mono-label mr-1">Start from</span>
        {#each starters as st (st.label)}
          <button class="btn quiet sm !h-7 !rounded-full !px-3 shadow-[inset_0_0_0_1px_var(--line)]" use:tip={st.hint} onclick={() => start(st.draft)}>{st.label}</button>
        {/each}
      </div>
    {/if}
    <div class="grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-2.5">
      <label for="mcp-name" class="text-[13px] font-medium">Name</label>
      <div class="flex items-center gap-2">
        <input
          id="mcp-name"
          value={draft.name}
          oninput={(e) => (draft.name = e.currentTarget.value.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32))}
          onblur={() => (draft.name = slugMcpName(draft.name))}
          placeholder="github"
          spellcheck="false"
          class="{field} w-[180px] font-mono !text-[12.5px]"
        />
        <span class="min-w-0 truncate text-[12px] text-fg-4">Tools show as <code class="font-mono">mcp__{draft.name || 'name'}__…</code></span>
      </div>

      <span class="text-[13px] font-medium">Runs as</span>
      <div class="flex items-center gap-3">
        {@render seg(MCP_TRANSPORTS, draft.transport, 'Runs as', (v) => (draft.transport = v as McpTransport))}
        <span class="min-w-0 truncate text-[12px] text-fg-4">{MCP_TRANSPORTS.find((t) => t.id === draft.transport)?.hint}</span>
      </div>

      {#if draft.transport === 'stdio'}
        <label for="mcp-command" class="self-start pt-1.5 text-[13px] font-medium">Command</label>
        <div>
          <input
            id="mcp-command"
            bind:value={draft.line}
            placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents"
            spellcheck="false"
            class="{field} w-full font-mono !text-[12.5px]"
          />
          <p class="mt-1 text-[12px] text-fg-3">The whole command line. Quote arguments with spaces. It starts with each reply that uses it, and stops when the reply ends.</p>
        </div>
        <span class="self-start pt-1.5 text-[13px] font-medium">Environment</span>
        <div>{@render pairs(draft.env, 'env')}</div>
      {:else}
        <label for="mcp-url" class="text-[13px] font-medium">URL</label>
        <input id="mcp-url" bind:value={draft.url} placeholder="https://example.com/mcp" spellcheck="false" class="{field} w-full font-mono !text-[12.5px]" />
        <span class="self-start pt-1.5 text-[13px] font-medium">Headers</span>
        <div>
          {@render pairs(draft.headers, 'headers')}
          <p class="mt-1 text-[12px] text-fg-3">For a token: <code class="font-mono text-fg-2">Authorization</code> with <code class="font-mono text-fg-2">Bearer …</code>. Servers that need a sign-in in the browser (OAuth) aren't supported yet.</p>
        </div>
      {/if}

      <label for="mcp-note" class="self-start pt-1.5 text-[13px] font-medium">What it's for</label>
      <input id="mcp-note" bind:value={draft.note} maxlength="400" placeholder="Optional: “Our team's issue tracker”, told to the bots" class="{field} w-full" />
    </div>
    <p class="mt-2.5 text-[12px] text-fg-4">Values are encrypted with your system's keychain and stay on this device.</p>
    <div class="mt-3 flex items-center gap-2">
      {#if triedSave && problem}<span class="mr-auto text-[12.5px] text-danger" in:fade={{ duration: 120 }}>{problem}</span>{:else}<span class="mr-auto"></span>{/if}
      {#if isNew}
        <button class="btn quiet sm" onclick={() => show(null)}>Cancel</button>
      {:else if dirty}
        <button class="btn quiet sm" in:fade={{ duration: 120 }} onclick={() => (draft = draftOf(open))}>Undo changes</button>
      {/if}
      <button class="btn solid sm" data-mcp-save disabled={saving || (!isNew && !dirty)} onclick={save}>{saving ? 'Saving…' : isNew ? 'Add and test' : 'Save and test'}</button>
    </div>
  </div>
{/snippet}

<section id="settings-connections">
  <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Connections</h3>
  <p class="mb-5 max-w-[62ch] text-fg-3">
    MCP servers give your bots tools from other apps and services: your files, GitHub, a database. Bots use them in a job's thread, and each tool asks you first unless you allow it. Changes apply from the next reply.
  </p>

  <div class="mx-0.5 mb-2.5 flex items-center gap-2">
    <span class="mono-label">Servers</span>
    {#if servers.length > 0}<span class="mono-label !text-fg-4 tabular-nums">{servers.length}</span>{/if}
    <span class="ml-auto"></span>
    <button class="text-[12px] text-fg-3 hover:text-fg" use:tip={'The file they are kept in, to edit by hand'} onclick={() => window.api.mcp.openFile()}>
      <span class="inline-flex items-center gap-1">mcp.json <Icon name="external" size={11} /></span>
    </button>
    <button class="btn quiet sm !h-8 !gap-1.5 !rounded-full !px-3 shadow-[inset_0_0_0_1px_var(--line)]" aria-expanded={importing} data-mcp-import onclick={() => ((importing = !importing), (importSkipped = []))}>
      <Icon name="paperclip" size={13} />Paste JSON
    </button>
    <button class="btn solid sm !h-8 !gap-1.5" data-mcp-add onclick={() => show('new')}><Icon name="plus" size={14} />Add a server</button>
  </div>

  {#if importing}
    <div class="group-card" transition:fade={{ duration: 120 }}>
      <div class="srow !block">
        <div class="l">
          <b>Paste a server's JSON</b>
          <span>As its instructions give it for Claude Desktop, Claude Code or VS Code: <code class="font-mono text-fg-2">{'{"mcpServers": {…}}'}</code>, or one server's own.</span>
        </div>
        <textarea
          bind:value={importText}
          rows="6"
          spellcheck="false"
          aria-label="Server JSON"
          placeholder={'{\n  "mcpServers": {\n    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }\n  }\n}'}
          class="mt-2.5 block w-full resize-y rounded-[10px] bg-transparent px-3 py-2.5 font-mono text-[12px] shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-2)]"
        ></textarea>
        {#each importSkipped as sk (sk.name)}
          <div class="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-danger"><span class="mt-0.5"><Icon name="alert" size={12} /></span><span><b class="!inline font-medium">{sk.name}</b> wasn't added: {sk.reason}</span></div>
        {/each}
        <div class="mt-3 flex justify-end gap-2">
          <button class="btn quiet sm" onclick={() => ((importing = false), (importSkipped = []))}>Cancel</button>
          <button class="btn solid sm" disabled={!importText.trim()} onclick={runImport}>Add servers</button>
        </div>
      </div>
    </div>
  {/if}

  {#if openId === 'new'}
    <div class="group-card" data-mcp-new in:fade={{ duration: 120 }}>
      <div class="srow">
        <span class="grid size-8 shrink-0 place-items-center rounded-[10px] bg-wash text-fg-2"><Icon name="plug" size={16} /></span>
        <div class="l"><b>New server</b><span>Saved and tested when you add it. It starts on, for every bot.</span></div>
      </div>
      {@render connection(true)}
    </div>
  {/if}

  {#if servers.length === 0 && openId !== 'new'}
    <div class="group-card">
      <div class="srow !flex-col !items-start !gap-1 !py-6 text-center">
        <span class="mx-auto mb-1 grid size-10 place-items-center rounded-full bg-wash text-fg-3"><Icon name="plug" size={18} /></span>
        <b class="mx-auto font-medium">No servers yet</b>
        <span class="mx-auto max-w-[46ch] text-[12.5px] text-fg-3">Add one by its command or URL, or paste the JSON from its instructions. Many are listed at modelcontextprotocol.io.</span>
      </div>
    </div>
  {:else if servers.length > 0}
    <ul class="group-card" aria-label="Servers">
      {#each servers as s (s.id)}
        {@const st = statusOf(s)}
        {@const expanded = openId === s.id}
        <li class="server" class:expanded data-mcp-server={s.name}>
          <div class="srow !gap-3">
            <button class="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={expanded} onclick={() => show(s.id)}>
              <span class="relative grid size-8 shrink-0 place-items-center rounded-[10px] bg-wash text-fg-2">
                <Icon name={s.transport === 'stdio' ? 'terminal' : 'globe'} size={15} />
                <span class="dot {st.tone}" aria-hidden="true"></span>
              </span>
              <span class="l">
                <b class="!flex items-baseline gap-2"><span class="truncate font-mono text-[13px]">{s.name}</span>{#if s.note}<span class="truncate text-[12.5px] font-normal text-fg-3">{s.note}</span>{/if}</b>
                <span class="truncate" class:!text-danger={st.tone === 'bad' && s.enabled}>{st.text} · {accessText[s.access].toLowerCase()} · {botsText(s)}</span>
              </span>
              <Icon name="chevronDown" size={14} class="shrink-0 text-fg-3 transition-transform duration-200 {expanded ? '' : '-rotate-90'}" />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={s.enabled}
              aria-label="Use {s.name}"
              class="switch"
              use:tip={s.enabled ? 'On: bots can use it' : 'Off: no bot uses it'}
              onclick={() => set(s.id, { enabled: !s.enabled })}
            ></button>
          </div>

          {#if expanded}
            <div class="panel" transition:fade={{ duration: 120 }}>
              <!-- How the last check went, and checking again. -->
              <div class="srow">
                <div class="l">
                  <b>{testing.includes(s.id) ? 'Checking…' : s.lastCheck?.status === 'connected' ? `Connected${s.lastCheck.server ? ` to ${s.lastCheck.server.name}${s.lastCheck.server.version ? ` ${s.lastCheck.server.version}` : ''}` : ''}` : s.lastCheck ? st.text : 'Not checked yet'}</b>
                  {#if testing.includes(s.id)}
                    <span>Starting it the way a reply would{s.transport === 'stdio' ? '. A first run may download it, which can take a while' : ''}.</span>
                  {:else if s.lastCheck?.error}
                    <span class="!text-danger select-text break-words font-mono !text-[12px]" data-mcp-error>{s.lastCheck.error}</span>
                  {:else if s.lastCheck}
                    <span>Checked {when(s.lastCheck.at)}.</span>
                  {:else}
                    <span>Test it to see its tools.</span>
                  {/if}
                </div>
                <button class="btn sm shrink-0" data-mcp-test disabled={testing.includes(s.id) || dirty} use:tip={dirty ? 'Save your changes first' : ''} onclick={() => test(s.id)}>
                  {#if testing.includes(s.id)}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="refresh" size={13} />{/if}Test
                </button>
              </div>

              <!-- Who may use it. -->
              <div class="srow !block">
                <div class="l"><b>Bots</b><span>{s.bots === 'all' ? 'Every bot, and bots you add later.' : 'Only the bots picked here.'} Not in your chat with {app.primaryBot?.name ?? 'Tomo'} itself, which hands such work to a job.</span></div>
                <div class="mt-2.5 flex flex-wrap gap-1.5">
                  {#each app.bots as b (b.id)}
                    {@const on = usedBy(s, b.id)}
                    <button
                      aria-pressed={on}
                      class="flex h-8 items-center gap-2 rounded-full pr-3 pl-1 text-[12.5px] font-medium transition-[background-color,box-shadow,color] {on ? 'glass text-fg' : 'text-fg-3 shadow-[inset_0_0_0_1px_var(--line)] hover:text-fg-2'}"
                      data-mcp-bot={b.name}
                      onclick={() => toggleBot(s, b.id)}
                    >
                      <span class:opacity-45={!on}><BotAvatar bot={b} size={24} /></span>{b.name}{#if on}<Icon name="check" size={12} class="text-fg-3" />{/if}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- What its tools may do. -->
              <div class="srow">
                <div class="l"><b>Its tools</b><span>{accessText[s.access]}{Object.keys(s.toolAccess).length ? `, except ${Object.keys(s.toolAccess).length} set below` : ''}. Ask shows an approval card in the job's thread.</span></div>
                {@render seg(verdicts, s.access, 'Its tools', (v) => set(s.id, { access: v as Verdict }))}
              </div>
              {#if s.tools && s.tools.length > 0}
                {@const list = showAllTools ? s.tools : s.tools.slice(0, 8)}
                {#each list as t (t.name)}
                  {@const v = mcpVerdict(s, t.name)}
                  <div class="rrow" data-mcp-tool={t.name}>
                    <div class="l">
                      <b class="flex items-center gap-1.5 !text-[13px]">
                        <span class="truncate font-mono !text-[12.5px]">{t.name}</span>
                        {#if t.readOnly}<span class="tag" use:tip={'The server says it only reads'}>reads</span>{/if}
                        {#if t.destructive}<span class="tag warn" use:tip={'The server says it can change or delete things. Only you can approve it, never Tomo.'}>changes</span>{/if}
                        {#if s.toolAccess[t.name]}<span class="text-[11px] font-normal text-fg-4">own rule</span>{/if}
                      </b>
                      {#if t.description}<span class="line-clamp-2">{t.description}</span>{/if}
                    </div>
                    {@render seg(verdicts, v, t.name, (x) => setToolVerdict(s, t.name, x as Verdict))}
                  </div>
                {/each}
                {#if s.tools.length > 8}
                  <button class="mx-4 mt-0.5 mb-3 text-[12px] text-fg-3 hover:text-fg" onclick={() => (showAllTools = !showAllTools)}>
                    {showAllTools ? 'Show fewer' : `Show all ${s.tools.length} tools`}
                  </button>
                {/if}
              {:else if s.tools}
                <div class="rrow"><div class="l"><span>It lists no tools.</span></div></div>
              {/if}

              <!-- How it is reached, folded away until Edit. -->
              <div class="srow">
                <div class="l">
                  <b>{s.transport === 'stdio' ? 'Command' : s.transport === 'sse' ? 'URL (SSE)' : 'URL'}</b>
                  <span class="truncate font-mono !text-[12px]" use:tip={reach(s)}>{reach(s)}</span>
                  {#if s.env.length || s.headers.length}
                    <span>{s.transport === 'stdio' ? 'Environment' : 'Headers'}: {(s.transport === 'stdio' ? s.env : s.headers).map((p) => p.key).join(', ')}</span>
                  {/if}
                </div>
                <button class="btn sm shrink-0" aria-expanded={editing} data-mcp-edit disabled={editing && dirty} onclick={() => (editing = !editing)}>
                  {#if editing}Close{:else}<Icon name="edit" size={13} />Edit{/if}
                </button>
              </div>
              {#if editing}{@render connection(false)}{/if}

              <div class="srow">
                {#if confirmDelete === s.id}
                  <div class="l" in:fade={{ duration: 120 }}><b>Delete {s.name}?</b><span>Its saved values go too. Bots lose its tools from the next reply.</span></div>
                  <button class="btn quiet sm shrink-0" onclick={() => (confirmDelete = null)}>Keep</button>
                  <button class="btn sm shrink-0 !text-danger" data-mcp-confirm-delete onclick={() => remove(s.id)}>Delete</button>
                {:else}
                  <div class="l"><b>Delete</b><span>Removes the server and its saved values</span></div>
                  <button class="btn quiet sm shrink-0 !text-danger" data-mcp-delete onclick={() => (confirmDelete = s.id)}>Delete server</button>
                {/if}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  /* As SettingsPage's: frosted panes on the frosted modal. */
  .group-card {
    margin-bottom: 16px;
    border-radius: var(--r-card);
    background: var(--glass-bg);
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--glass-ring),
      var(--shadow-sm);
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 13px 16px;
    border-top: 1px solid var(--line);
  }
  .srow:first-child,
  .server:first-child > .srow:first-child {
    border-top: 0;
  }
  .server + .server {
    border-top: 1px solid var(--line);
  }
  .server > .srow:first-child {
    border-top: 0;
  }
  /* An open server's details sit a shade in from its row. */
  .panel {
    background: color-mix(in srgb, var(--wash) 45%, transparent);
    border-top: 1px solid var(--line);
  }
  .panel > .srow:first-child {
    border-top: 0;
  }
  .server.expanded:last-child .panel {
    border-radius: 0 0 var(--r-card) var(--r-card);
  }
  .l {
    display: block;
    flex: 1;
    min-width: 0;
  }
  .l :global(b) {
    display: block;
    font-weight: 500;
  }
  .l > span {
    display: block;
    margin-top: 1px;
    font-size: 12.5px;
    color: var(--fg-3);
  }
  .rrow {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 7px 16px 7px 16px;
  }
  .rrow:last-of-type {
    padding-bottom: 11px;
  }
  .verdicts :global(button) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    font-size: 12px;
  }
  .verdicts :global(button.block[aria-checked='true']) {
    color: var(--danger);
  }
  /* The status of a server, on the corner of its icon. */
  .dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    box-shadow: 0 0 0 2px var(--glass-bg-solid, var(--card));
    background: var(--fg-4);
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.bad {
    background: var(--danger);
  }
  .dot.warn {
    background: #d68a1b;
  }
  .dot.idle {
    background: transparent;
    box-shadow:
      0 0 0 2px var(--glass-bg-solid, var(--card)),
      inset 0 0 0 1.5px var(--fg-4);
  }
  .tag {
    flex: none;
    padding: 0 6px;
    border-radius: 999px;
    font-family: var(--face-label);
    font-size: 10.5px;
    font-weight: 500;
    line-height: 17px;
    color: var(--fg-3);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .tag.warn {
    color: var(--danger);
  }
  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 1.5px solid var(--line-2);
    border-top-color: var(--fg-2);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
