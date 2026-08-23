<#
.SYNOPSIS
  Create the shared mailbox that packet emails are sent from.

.DESCRIPTION
  Microsoft blocks app-only access to mailboxes belonging to privileged
  administrators. The onboarding app can therefore never draft into the
  founder's mailbox, no matter how the access policy is scoped — the block is
  a service-level guardrail, not a setting. Confirmed empirically: the same
  token, policy and code work against a non-admin mailbox and fail against an
  admin one with "[RAOP] : Blocked by tenant configured AppOnly AccessPolicy".

  A distribution list is not an alternative. It has no mailbox store, so it can
  hold no drafts — Graph answers 404 ErrorInvalidUser rather than 403.

  So: a shared mailbox. It needs no licence, appears in Outlook automatically
  for anyone with Full Access, and belongs to no admin.

  Replies do not come back here. Each team's packet carries a Reply-To of its
  own head coach, so a family reaches the person running their season.

.EXAMPLE
  pwsh -File scripts/onboarding/graph-create-sender.ps1
  pwsh -File scripts/onboarding/graph-create-sender.ps1 -Address join@stemplusc.org -DisplayName "STEM+C"
#>

param(
  [string] $Address     = 'registration@stemplusc.org',
  [string] $DisplayName = 'STEM+C Registration',
  [string] $Admin       = 'steven@stemplusc.org',
  [string] $GroupId     = 'stemc-onboarding-senders@stemplusc.org',
  # Who gets Full Access, so the drafts show up in their Outlook.
  [string[]] $Owners    = @('steven@stemplusc.org')
)

$ErrorActionPreference = 'Stop'
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -UserPrincipalName $Admin -ShowBanner:$false

$alias = $Address.Split('@')[0]

# ── Mailbox ─────────────────────────────────────────────────────────────────
if (Get-Mailbox -Identity $Address -ErrorAction SilentlyContinue) {
  Write-Host "`nMailbox $Address already exists." -ForegroundColor Yellow
} else {
  Write-Host "`nCreating shared mailbox $Address" -ForegroundColor Cyan
  New-Mailbox -Shared -Name $DisplayName -DisplayName $DisplayName -Alias $alias -PrimarySmtpAddress $Address | Out-Null
  Write-Host "Created." -ForegroundColor Green
  # Provisioning is not instant; the grants below can fail if they race it.
  Start-Sleep -Seconds 10
}

# ── Access ──────────────────────────────────────────────────────────────────
# FullAccess makes it appear in Outlook; SendAs lets that person send from it.
# Both are needed — with only FullAccess the drafts are visible but unsendable.
foreach ($o in $Owners) {
  Write-Host "Granting $o full access and send-as" -ForegroundColor Cyan
  Add-MailboxPermission -Identity $Address -User $o -AccessRights FullAccess -InheritanceType All -ErrorAction SilentlyContinue | Out-Null
  Add-RecipientPermission -Identity $Address -Trustee $o -AccessRights SendAs -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
}

# ── Access policy ───────────────────────────────────────────────────────────
# The app is restricted to this group, so a mailbox outside it is refused.
$members = @(Get-DistributionGroupMember -Identity $GroupId | Select-Object -ExpandProperty PrimarySmtpAddress)
if ($members -contains $Address) {
  Write-Host "Already in $GroupId." -ForegroundColor Yellow
} else {
  Write-Host "Adding $Address to $GroupId" -ForegroundColor Cyan
  Add-DistributionGroupMember -Identity $GroupId -Member $Address
}

# ── Verify ──────────────────────────────────────────────────────────────────
Write-Host "`nVerifying:" -ForegroundColor Cyan
$r = Test-ApplicationAccessPolicy -Identity $Address -AppId '11fd2a25-158c-42da-b8dd-3932aaa96b47'
$colour = if ($r.AccessCheckResult -eq 'Granted') { 'Green' } else { 'Red' }
Write-Host ("  {0,-34} {1}  (want Granted)" -f $Address, $r.AccessCheckResult) -ForegroundColor $colour

Write-Host "`nNow point the scripts at it — in .env:" -ForegroundColor Cyan
Write-Host "  export MS_SENDER=$Address"
Write-Host "`nThen:" -ForegroundColor Cyan
Write-Host "  node scripts/onboarding/graph-check.mjs --mailbox rob@stemplusc.org"
Write-Host "`nGroup membership can take a few minutes to reach the access policy;"
Write-Host "a 403 straight after this is usually propagation, not a mistake.`n"

Disconnect-ExchangeOnline -Confirm:$false
