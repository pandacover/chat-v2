<script lang="ts">
  // What a bot said in the open: a task, message or report in a job's shared thread, or a message
  // another bot sent to a bot's own thread. In Tomo's conversation a report comes as this card,
  // labelled with its job, which it opens. The card names who wrote it and who it is for, and says
  // when it is waiting for the user's OK, was declined, or was stopped for bouncing.
  import type { Attachment, Job, Message } from '@shared/types'
  import AttachmentChip from './AttachmentChip.svelte'
  import { tip } from '@/lib/tooltip'
  import { fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import BotAvatar, { PRESENCE_LABELS } from './BotAvatar.svelte'
  import Icon from './Icon.svelte'
  import Markdown from './Markdown.svelte'

  let { message, job = null, fresh = false }: { message: Message; job?: Job | null; fresh?: boolean } = $props()

  const botBy = (id: string | null) => (id ? (app.bots.find((b) => b.id === id) ?? null) : null)
  const author = $derived(botBy(message.authorBotId))
  const to = $derived(message.post?.to ? botBy(message.post.to) : null)
  /** A bot's message in another bot's own thread is a user turn there; it says what it was. */
  const kind = $derived(message.post?.kind ?? 'message')
  const label = $derived(kind === 'task' ? 'Task' : kind === 'report' ? 'Report' : 'Message')
  const inThread = $derived(message.role === 'user')
  const postState = $derived(message.post?.state ?? null)
  const presence = $derived(author ? (app.presence[author.id] ?? null) : null)

  const saveImage = async (a: Attachment) => {
    const path = await app.attempt(() => window.api.attachments.saveAs(a.id, a.name))
    if (path) app.toast(`Saved to ${path}`, 'info')
  }

  let copied = $state(false)
  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    copied = true
    setTimeout(() => (copied = false), 1400)
  }
</script>

<div
  class="post group/post rounded-[var(--r-card)] bg-card px-4 pt-3 pb-3.5 {postState === 'held'
    ? 'shadow-[0_0_0_1px_color-mix(in_srgb,var(--danger)_35%,transparent),var(--shadow-sm)]'
    : 'shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)]'}"
  data-post={kind}
  data-post-state={postState ?? undefined}
  data-reply-scope
  in:fly={{ y: 4, duration: fresh ? 220 : 0 }}
>
  <div class="mb-2 flex h-6 min-w-0 items-center gap-2 text-[13px]" data-post-head>
    <BotAvatar bot={author ?? { name: '?', avatar: null }} size={22} {presence} />
    <span class="shrink-0 font-medium text-fg" use:tip={presence && presence !== 'idle' ? PRESENCE_LABELS[presence] : null}>{author?.name ?? 'A deleted bot'}</span>
    {#if !inThread}
      <Icon name="chevronRight" size={12} class="shrink-0 text-fg-4" />
      <span class="shrink-0 text-fg-2">{to?.name ?? (message.post?.to ? 'A deleted bot' : 'Everyone')}</span>
    {/if}
    <span class="mono-label shrink-0 !text-[10.5px]">{label}</span>
    {#if job}
      <span class="text-fg-4">·</span>
      <button class="min-w-0 truncate text-fg-3 transition-colors hover:text-fg" use:tip={job.summary ?? 'Open this job'} data-post-job onclick={() => app.openJob(job)}>{job.title}</button>
    {/if}
    <span class="flex-1"></span>
    <button class="icon-btn size-[24px] !rounded-lg opacity-0 transition-opacity group-hover/post:opacity-100 focus-visible:opacity-100" use:tip={copied ? 'Copied' : 'Copy'} onclick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  </div>
  <div class="text-[14.5px]">
    <Markdown source={message.content} streaming={false} live={false} />
  </div>
  {#if message.attachments.length > 0}
    <!-- What the reporting bot made for you (a screenshot it saved), carried from its thread. -->
    <div class="mt-2.5 flex flex-wrap gap-2" data-post-files>
      {#each message.attachments as a (a.id)}
        {#if a.kind === 'image'}
          <div class="group/shot relative max-w-md overflow-hidden rounded-[12px] shadow-[0_0_0_1px_var(--ring)]">
            <img src={window.api.attachments.url(a.id)} alt={a.name} class="block max-h-72 w-auto" />
            <button class="btn solid sm absolute top-2 right-2 opacity-0 transition-opacity group-hover/shot:opacity-100 focus-visible:opacity-100" use:tip={`Save ${a.name}`} onclick={() => saveImage(a)}>
              Save
            </button>
          </div>
        {:else}
          <AttachmentChip attachment={a} />
        {/if}
      {/each}
    </div>
  {/if}
  {#if postState}
    <div class="mt-2 flex items-center gap-1.5 text-[12.5px] {postState === 'held' ? 'text-danger' : 'text-fg-3'}">
      <Icon name={postState === 'held' ? 'lock' : postState === 'declined' ? 'x' : 'alert'} size={13} />
      {postState === 'held' ? 'Waiting for your OK to pass this on' : postState === 'declined' ? 'Not passed on: you declined it' : 'Not passed on: the same request kept bouncing back and forth'}
    </div>
  {/if}
</div>
