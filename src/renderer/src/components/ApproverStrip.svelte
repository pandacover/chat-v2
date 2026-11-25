<script lang="ts">
  // On a job's threads while Tomo approves for the user there (they told it to, in their own words):
  // a quiet line saying so, the words on hover, and a button that hands approvals back to the user.
  import { tip } from '@/lib/tooltip'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let { jobId }: { jobId: string } = $props()

  const job = $derived(app.jobs.find((j) => j.id === jobId) ?? null)
  const name = $derived(app.primaryBot?.name ?? 'Tomo')
</script>

{#if job?.approvesForUser}
  <div class="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-2 px-8 pt-2 text-[12.5px] text-fg-2" data-approver-strip>
    <Icon name="check" size={13} class="text-fg-3" />
    <span class="min-w-0 truncate" use:tip={`You said: “${job.approvesForUser}”. ${name} approves what that and the job cover; anything else, and anything irreversible, still asks you.`}
      >{name} approves for you on this job</span
    >
    <button class="btn quiet sm shrink-0 !h-6 !px-2" data-approver-stop onclick={() => void app.stopApproving(jobId)}>Ask me instead</button>
  </div>
{/if}
