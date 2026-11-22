<script lang="ts">
  // Settings › Bots: each bot's name, avatar, model, thinking and instructions, the tool modules it
  // has, and its rules: allow, ask or block for each kind of tool call. Rules always the user's
  // (irreversible actions) are locked to ask or block. Changes save shortly after the last one.
  // Bots are added and deleted here; any can be made the primary (the fox is the primary's).
  import { onDestroy } from 'svelte'
  import type { Bot, Effort } from '@shared/types'
  import { MODULES, RULE_GROUPS, ruleValue, type ModuleId, type RuleId, type Rules, type Verdict } from '@shared/rules'
  import { AVATAR_TINTS, avatarOf, type AvatarTint } from '@shared/bots'
  import { shortcut } from '@/lib/keys'
  import { fade } from '@/lib/motion'
  import { takeSettingsBot } from '@/lib/settingsNav'
  import { app } from '@/lib/store.svelte'
  import { tip } from '@/lib/tooltip'
  import BotAvatar from './BotAvatar.svelte'
  import Icon from './Icon.svelte'
  import ModelPicker from './ModelPicker.svelte'

  let { onstatus }: { onstatus: (s: 'saving' | 'saved' | 'idle') => void } = $props()

  const efforts: Array<{ id: Effort; label: string; hint: string }> = [
    { id: 'low', label: 'Low', hint: 'Answers quickly and thinks little. Cheapest.' },
    { id: 'medium', label: 'Medium', hint: 'Thinks where it helps. The default.' },
    { id: 'high', label: 'High', hint: 'Thinks longer before it answers, for harder questions.' },
    { id: 'xhigh', label: 'Higher', hint: 'Thinks much longer. Slower and costs more.' },
    { id: 'max', label: 'Max', hint: 'Thinks as long as it needs. The slowest and most expensive.' }
  ]
  const verdicts: Array<{ id: Verdict; label: string }> = [
    { id: 'allow', label: 'Allow' },
    { id: 'ask', label: 'Ask' },
    { id: 'block', label: 'Block' }
  ]

  // One bot at a time: Tomo until workers arrive, then picked from the row at the top.
  const askedFor = takeSettingsBot()
  let selectedId = $state((askedFor && app.bots.some((b) => b.id === askedFor) ? askedFor : null) ?? app.primaryBot?.id ?? app.bots[0]?.id ?? '')
  const selected = $derived(app.bots.find((b) => b.id === selectedId) ?? null)
  const primaryName = $derived(app.primaryBot?.name ?? 'Tomo')

  type Draft = Pick<Bot, 'name' | 'avatar' | 'model' | 'effort' | 'instructions' | 'modules' | 'rules'>
  const draftOf = (b: Bot | null): Draft => ({
    name: b?.name ?? 'Tomo',
    avatar: b?.avatar ?? null,
    model: b?.model ?? app.settings!.settings.defaultModel,
    effort: b?.effort ?? app.settings!.settings.effort,
    // A worker has only its own; the primary started from Settings' instructions.
    instructions: b?.instructions ?? (b && !b.isPrimary ? '' : app.settings!.settings.systemPrompt),
    modules: [...(b?.modules ?? [])],
    rules: { ...(b?.rules ?? {}) }
  })
  let draft = $state<Draft>(draftOf(app.bots.find((b) => b.id === selectedId) ?? null))

  let timer: ReturnType<typeof setTimeout> | undefined
  let savedTimer: ReturnType<typeof setTimeout> | undefined
  let pendingFor: string | null = null
  const persist = async (id: string, patch: Draft) => {
    timer = undefined
    pendingFor = null
    onstatus('saving')
    const fallback = app.bots.find((b) => b.id === id)?.isPrimary ? 'Tomo' : 'New bot'
    const ok = await app.updateBot(id, { ...patch, name: patch.name.trim() || fallback })
    onstatus(ok ? 'saved' : 'idle')
    clearTimeout(savedTimer)
    if (ok) savedTimer = setTimeout(() => onstatus('idle'), 1600)
  }
  /** Saves the draft shortly after the last change. */
  const changed = () => {
    clearTimeout(timer)
    pendingFor = selectedId
    const snapshot = $state.snapshot(draft) as Draft
    const id = selectedId
    timer = setTimeout(() => void persist(id, snapshot), 450)
  }
  const flush = () => {
    if (!timer || !pendingFor) return
    clearTimeout(timer)
    void persist(pendingFor, $state.snapshot(draft) as Draft)
  }
  onDestroy(flush)

  const pick = (id: string) => {
    if (id === selectedId) return
    flush()
    selectedId = id
    draft = draftOf(app.bots.find((b) => b.id === id) ?? null)
    confirmingDelete = false
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    draft[key] = value
    changed()
  }
  const toggleModule = (id: ModuleId) =>
    set('modules', draft.modules.includes(id) ? draft.modules.filter((m) => m !== id) : MODULES.map((m) => m.id).filter((m) => m === id || draft.modules.includes(m)))
  const setRule = (id: RuleId, v: Verdict) => set('rules', { ...draft.rules, [id]: v } as Rules)
  const custom = $derived(RULE_GROUPS.some((g) => g.items.some((i) => ruleValue(draft.rules, i.id) !== ruleValue({}, i.id))))

  const computerOn = $derived(draft.modules.includes('computer') && app.computerSupported)
  const moduleLabel = (id: ModuleId) => MODULES.find((m) => m.id === id)?.label ?? id

  // Adding, deleting and the primary.
  let confirmingDelete = $state(false)
  const add = async () => {
    flush()
    const bot = await app.createBot({ name: 'New bot' })
    if (!bot) return
    selectedId = bot.id
    draft = draftOf(bot)
    confirmingDelete = false
  }
  const remove = async () => {
    const id = selectedId
    confirmingDelete = false
    clearTimeout(timer)
    timer = undefined
    pendingFor = null
    await app.removeBot(id)
    selectedId = app.primaryBot?.id ?? app.bots[0]?.id ?? ''
    draft = draftOf(app.bots.find((b) => b.id === selectedId) ?? null)
  }
  const makePrimary = async () => {
    flush()
    await app.setPrimary(selectedId)
  }

  // The avatar: the fox (the primary's), an initial on a tint, or a picture.
  const avatar = $derived(avatarOf(draft.avatar))
  const TINT_LABELS: Record<AvatarTint, string> = { plain: 'Plain', blue: 'Blue', green: 'Green', red: 'Red', warm: 'Warm' }
  let picker: HTMLInputElement | undefined = $state()
  /** A picture, cropped square from its centre and shrunk to 96 px, as a small data URL. */
  const pickImage = async (file: File | undefined) => {
    if (!file) return
    try {
      const bitmap = await createImageBitmap(file)
      const side = Math.min(bitmap.width, bitmap.height)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 96
      canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96)
      set('avatar', `image:${canvas.toDataURL('image/webp', 0.85)}`)
    } catch {
      app.toast("That picture couldn't be read.")
    } finally {
      if (picker) picker.value = ''
    }
  }
</script>

<section id="settings-bots">
  <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Bots</h3>
  <p class="mb-5 max-w-[60ch] text-fg-3">
    Who answers you, and what each may do on its own. {primaryName} hands work to the other bots, and they report back. Anything a rule says to ask about comes to you on an approval card.
  </p>

  <div class="mb-4 flex flex-wrap items-center gap-1.5">
    {#if app.bots.length > 1}
      <div class="contents" role="radiogroup" aria-label="Bot">
        {#each app.bots as b (b.id)}
          <button
            role="radio"
            aria-checked={b.id === selectedId}
            class="flex h-9 items-center gap-2 rounded-full pr-3.5 pl-1.5 text-[13px] font-medium transition-colors {b.id === selectedId ? 'glass text-fg' : 'text-fg-2 hover:bg-wash'}"
            data-bot-pick={b.name}
            onclick={() => pick(b.id)}
          >
            <BotAvatar bot={b} size={26} presence={app.presence[b.id] ?? null} />{b.name}
          </button>
        {/each}
      </div>
    {/if}
    <button class="btn quiet sm !h-9 !gap-1.5 !rounded-full !px-3.5" data-add-bot use:tip={`A worker: ${primaryName} hands it jobs, and you can talk to it directly`} onclick={add}>
      <Icon name="plus" size={14} />Add a bot
    </button>
  </div>

  <div class="group-card" data-bot={selected?.id}>
    <div class="srow !justify-start !gap-3.5">
      <BotAvatar bot={draft} size={44} />
      <div class="l">
        <div class="flex items-center gap-2">
          <input
            value={draft.name}
            oninput={(e) => set('name', e.currentTarget.value.slice(0, 40))}
            aria-label="Bot name"
            class="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 -mx-1 text-[15px] font-medium outline-none focus:bg-canvas focus:shadow-[inset_0_0_0_1px_var(--line-2)]"
          />
          {#if selected?.isPrimary}<span class="mono-label shrink-0">Primary</span>{/if}
        </div>
        <span>
          {#if selected?.isPrimary}
            Hears everything you say without picking a job (typed, or with <span class="whitespace-nowrap">{shortcut('M')}</span>), opens a job for each topic, and hands jobs to the other bots.
          {:else}
            A worker: {primaryName} hands it jobs, and it reports back. Open any of its threads to talk to it directly.
          {/if}
        </span>
      </div>
    </div>
    <div class="srow">
      <div class="l"><b>Avatar</b><span>{selected?.isPrimary ? 'The fox, the first letter of its name, or a picture' : 'The first letter of its name on a colour, or a picture'}</span></div>
      <div class="flex shrink-0 items-center gap-1" role="radiogroup" aria-label="Avatar">
        {#if selected?.isPrimary}
          <button role="radio" class="swatch" aria-checked={avatar.kind === 'mascot'} aria-label="The fox" use:tip={'The fox'} onclick={() => set('avatar', 'mascot')}>
            <BotAvatar bot={{ name: draft.name, avatar: 'mascot' }} size={26} />
          </button>
        {/if}
        {#each AVATAR_TINTS as t (t)}
          <button
            role="radio"
            class="swatch"
            aria-checked={avatar.kind === 'initial' && avatar.tint === t}
            aria-label={TINT_LABELS[t]}
            use:tip={TINT_LABELS[t]}
            data-tint={t}
            onclick={() => set('avatar', t === 'plain' ? null : `tint:${t}`)}
          >
            <BotAvatar bot={{ name: draft.name || '?', avatar: `tint:${t}` }} size={26} />
          </button>
        {/each}
        <button role="radio" class="swatch" aria-checked={avatar.kind === 'image'} aria-label="A picture" use:tip={'A picture'} onclick={() => picker?.click()}>
          {#if avatar.kind === 'image'}
            <BotAvatar bot={draft} size={26} />
          {:else}
            <span class="grid size-[26px] place-items-center rounded-full text-fg-3 shadow-[inset_0_0_0_1px_var(--line-2)]"><Icon name="camera" size={13} /></span>
          {/if}
        </button>
        <input bind:this={picker} type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={(e) => void pickImage(e.currentTarget.files?.[0])} />
      </div>
    </div>
    <div class="srow">
      <div class="l"><b>Model</b><span>Replies run on this unless a job picks its own</span></div>
      <div class="w-[200px] shrink-0"><ModelPicker block value={draft.model ?? ''} onchange={(id) => set('model', id)} /></div>
    </div>
    <div class="srow !flex-col !items-stretch !gap-2.5">
      <div class="l">
        <b>Thinking</b>
        <span>
          {efforts.find((e) => e.id === draft.effort)?.hint} Models that don't think ignore this.
          {#if computerOn}With Computer on, replies think at most Medium (Low on Sonnet and Haiku), so clicks stay quick.{/if}
        </span>
      </div>
      <div class="seg self-start" role="radiogroup" aria-label="Thinking">
        {#each efforts as e (e.id)}
          <button role="radio" aria-checked={draft.effort === e.id} onclick={() => set('effort', e.id)}>{e.label}</button>
        {/each}
      </div>
    </div>
    <div class="srow" id="settings-instructions">
      <div class="l">
        <div class="flex items-baseline gap-2">
          <b>Instructions</b>
          {#if selected?.isPrimary}
            <button class="ml-auto inline-flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg" use:tip={app.settings!.configPath} onclick={() => window.api.settings.openConfigFile()}>
              Open config.json <Icon name="external" size={11} />
            </button>
          {/if}
        </div>
        <span>
          {selected?.isPrimary
            ? 'Sent with every reply. A job can replace them with its own from the button at its top right.'
            : `What it is for and how it works. Its first line tells ${primaryName} what to hand it.`}
        </span>
        <textarea
          value={draft.instructions ?? ''}
          oninput={(e) => set('instructions', e.currentTarget.value)}
          rows="5"
          aria-label="Instructions"
          placeholder={selected?.isPrimary ? '' : 'Researches questions on the web and reports what it found, with sources.'}
          class="mt-2.5 block min-h-[84px] w-full resize-y rounded-[10px] bg-transparent px-3 py-2.5 text-[13.5px] shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-2)]"
        ></textarea>
      </div>
    </div>
    {#if selected && !selected.isPrimary}
      <div class="srow">
        <div class="l"><b>Primary</b><span>Make {draft.name || 'it'} the bot that hears everything you say and hands out the work</span></div>
        <button class="btn sm shrink-0" data-make-primary onclick={makePrimary}>Make primary</button>
      </div>
      <div class="srow">
        {#if confirmingDelete}
          <div class="l" in:fade={{ duration: 120 }}><b>Delete {draft.name || 'this bot'}?</b><span>Its threads and what it said stay, unsigned.</span></div>
          <button class="btn quiet sm shrink-0" onclick={() => (confirmingDelete = false)}>Keep</button>
          <button class="btn sm shrink-0 !text-danger" data-confirm-delete onclick={remove}>Delete</button>
        {:else}
          <div class="l"><b>Delete</b><span>Stops what it is doing; its threads stay, readable</span></div>
          <button class="btn quiet sm shrink-0 !text-danger" data-delete-bot onclick={() => (confirmingDelete = true)}>Delete bot</button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="mono-label mx-0.5 mt-[22px] mb-2.5">Tools</div>
  <div class="group-card" aria-label="Tools">
    {#each MODULES as m (m.id)}
      {@const unsupported = m.id === 'computer' && !app.computerSupported}
      <div class="srow">
        <Icon name={m.id === 'computer' ? 'monitor' : 'globe'} size={16} class="shrink-0 text-fg-3" />
        <div class="l !-ml-2.5">
          <b>{m.label}</b>
          <span>{unsupported ? "Not available on this system: computer use needs Windows, macOS, or Linux with an X11 display." : m.hint}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.modules.includes(m.id)}
          aria-label={m.label}
          class="switch"
          disabled={unsupported}
          onclick={() => toggleModule(m.id)}
        ></button>
      </div>
    {/each}
  </div>

  <div class="mx-0.5 mt-[22px] mb-1 flex items-baseline gap-2">
    <span class="mono-label">Rules</span>
    {#if custom}
      <button class="ml-auto text-[12px] text-fg-3 hover:text-fg" in:fade={{ duration: 120 }} onclick={() => set('rules', {})}>Reset to defaults</button>
    {/if}
  </div>
  <p class="mx-0.5 mb-2.5 text-[12.5px] text-fg-3">
    Allow runs it. Ask waits for your OK on an approval card. Block never runs it. Some actions are always yours to approve. A bot asking another bot that may do more than it may waits for your OK too.
  </p>
  <div class="group-card" aria-label="Rules">
    {#each RULE_GROUPS as g (g.id)}
      {@const off = g.needs !== null && !draft.modules.includes(g.needs)}
      <div class="grp" data-rule-group={g.id}>
        <div class="flex items-baseline gap-2 px-4 pt-3 pb-1">
          <span class="mono-label">{g.label}</span>
          {#if off}<span class="text-[12px] text-fg-4">Turn on {moduleLabel(g.needs!)} to use these</span>{/if}
        </div>
        {#each g.items as item (item.id)}
          {@const value = ruleValue(draft.rules, item.id)}
          <div class="rrow" class:off data-rule={item.id}>
            <div class="l">
              <b class="!text-[13.5px]">{item.label}</b>
              <span>{item.hint}</span>
            </div>
            <div class="seg verdicts" role="radiogroup" aria-label={item.label}>
              {#each verdicts as o (o.id)}
                {@const lockedOut = item.locked && o.id === 'allow'}
                <button
                  role="radio"
                  aria-checked={value === o.id}
                  class:block={o.id === 'block'}
                  disabled={lockedOut || off}
                  use:tip={lockedOut ? 'Always yours: this always asks first' : ''}
                  onclick={() => setRule(item.id, o.id)}
                >
                  {#if lockedOut}<Icon name="lock" size={11} />{/if}{o.label}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/each}
  </div>
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
  .srow:first-child {
    border-top: 0;
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
  .grp + .grp {
    border-top: 1px solid var(--line);
  }
  .rrow {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 7px 10px 7px 16px;
  }
  .rrow:last-child {
    padding-bottom: 11px;
  }
  .rrow.off .l {
    opacity: 0.5;
  }
  .verdicts button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    font-size: 12px;
  }
  .verdicts button:disabled {
    color: var(--fg-4);
    cursor: default;
  }
  .verdicts button.block[aria-checked='true'] {
    color: var(--danger);
  }
  /* An avatar choice: a ring around the one picked. */
  .swatch {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 9999px;
    transition: box-shadow 120ms;
  }
  .swatch:hover {
    box-shadow: 0 0 0 1px var(--line-2);
  }
  .swatch[aria-checked='true'] {
    box-shadow: 0 0 0 1.5px var(--fg);
  }
</style>
