<#
.SYNOPSIS
  Restrict the onboarding mail app to the mailboxes it actually sends from.

.DESCRIPTION
  Mail.Send as an *application* permission covers every mailbox in the tenant.
  Nothing in Entra narrows it, and nothing warns you that it is wide open — the
  app works identically either way. An Exchange ApplicationAccessPolicy is what
  narrows it.

  This script creates a mail-enabled security group holding the mailboxes the
  onboarding scripts draft into, scopes the app to that group, and proves the
  result by testing a mailbox that should now be refused.

  A group rather than a single address because Jedi packets are drafted into
  the Jedi coach's mailbox, not the Samurai coach's. Adding a coach later means
  adding them to the group, not rewriting the policy.

  Run once. Safe to re-run: it reports what already exists instead of
  duplicating it.

.NOTES
  Needs Exchange Administrator or Global Administrator.
  Propagation can take up to an hour — a denial that does not appear
  immediately is not necessarily a failure.
#>

param(
  [string] $AppId    = '11fd2a25-158c-42da-b8dd-3932aaa96b47',
  [string] $Admin    = 'steven@stemplusc.org',
  [string] $GroupId  = 'stemc-onboarding-senders@stemplusc.org',
  [string[]] $Senders = @('steven@stemplusc.org', 'rob@stemplusc.org'),
  # A mailbox that must NOT be reachable, to prove the restriction bites.
  # Optional: when omitted, the script finds one outside the group itself.
  [string] $DenyProbe
)

$ErrorActionPreference = 'Stop'

# ── Module ──────────────────────────────────────────────────────────────────
if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
  Write-Host "Installing ExchangeOnlineManagement..." -ForegroundColor Cyan
  Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force
}
Import-Module ExchangeOnlineManagement

# ── Connect (opens a browser) ───────────────────────────────────────────────
Write-Host "`nConnecting to Exchange Online as $Admin..." -ForegroundColor Cyan
Connect-ExchangeOnline -UserPrincipalName $Admin -ShowBanner:$false

# ── Group ───────────────────────────────────────────────────────────────────
$group = Get-DistributionGroup -Identity $GroupId -ErrorAction SilentlyContinue
if ($group) {
  Write-Host "`nGroup $GroupId already exists." -ForegroundColor Yellow
} else {
  Write-Host "`nCreating mail-enabled security group $GroupId" -ForegroundColor Cyan
  # Mail-enabled *security* group: ApplicationAccessPolicy will not accept a
  # plain distribution list or a Microsoft 365 group.
  New-DistributionGroup `
    -Name 'STEMC Onboarding Senders' `
    -Alias ($GroupId.Split('@')[0]) `
    -PrimarySmtpAddress $GroupId `
    -Type Security `
    -Members $Senders | Out-Null
  Write-Host "Created." -ForegroundColor Green
}

Write-Host "`nMembers:" -ForegroundColor Cyan
Get-DistributionGroupMember -Identity $GroupId |
  Select-Object -ExpandProperty PrimarySmtpAddress |
  ForEach-Object { Write-Host "  $_" }

# ── Policy ──────────────────────────────────────────────────────────────────
$existing = Get-ApplicationAccessPolicy -ErrorAction SilentlyContinue |
  Where-Object { $_.AppId -eq $AppId }

if ($existing) {
  Write-Host "`nPolicy already present for this app:" -ForegroundColor Yellow
  $existing | Format-List AppId, ScopeName, AccessRight, Description
} else {
  Write-Host "`nRestricting app $AppId to $GroupId" -ForegroundColor Cyan
  New-ApplicationAccessPolicy `
    -AppId $AppId `
    -PolicyScopeGroupId $GroupId `
    -AccessRight RestrictAccess `
    -Description 'STEM+C onboarding mailer' | Out-Null
  Write-Host "Created." -ForegroundColor Green
}

# ── Prove it ────────────────────────────────────────────────────────────────
# A policy you have not tested is a policy you are hoping about. The senders
# must come back Granted; anyone else must come back Denied.
#
# The denial is the half that matters — "Granted for the people we listed" is
# also true of a policy that does not exist. Without a refusal, nothing here
# distinguishes a working restriction from no restriction at all.
Write-Host "`nVerifying:" -ForegroundColor Cyan

function Test-Access($address, $want) {
  try {
    $r = Test-ApplicationAccessPolicy -Identity $address -AppId $AppId -ErrorAction Stop
    $colour = if ($r.AccessCheckResult -eq $want) { 'Green' } else { 'Red' }
    Write-Host ("  {0,-34} {1}  (want {2})" -f $address, $r.AccessCheckResult, $want) -ForegroundColor $colour
    return $r.AccessCheckResult -eq $want
  } catch {
    Write-Host ("  {0,-34} could not test: {1}" -f $address, $_.Exception.Message.Split('|')[-1].Trim()) -ForegroundColor Yellow
    return $false
  }
}

foreach ($m in $Senders) { Test-Access $m 'Granted' | Out-Null }

# Pick a mailbox outside the group rather than asking for one. Nobody should
# have to know a third address by heart to find out whether this worked.
if (-not $DenyProbe) {
  $members = @(Get-DistributionGroupMember -Identity $GroupId |
    Select-Object -ExpandProperty PrimarySmtpAddress)
  $DenyProbe = Get-Mailbox -ResultSize 50 |
    Where-Object { $_.PrimarySmtpAddress -notin $members } |
    Select-Object -First 1 -ExpandProperty PrimarySmtpAddress
}

if ($DenyProbe) {
  $denied = Test-Access $DenyProbe 'Denied'
  if (-not $denied) {
    Write-Host "`n  A non-member came back Granted. Either the policy is not in force yet" -ForegroundColor Yellow
    Write-Host "  (propagation runs up to an hour) or it is not restricting. Re-run this" -ForegroundColor Yellow
    Write-Host "  script later; if it still says Granted, the policy needs another look." -ForegroundColor Yellow
  }
} else {
  Write-Host "`n  No mailbox outside the group to test against, so the restriction is" -ForegroundColor Yellow
  Write-Host "  unproven. This tenant may have only these mailboxes." -ForegroundColor Yellow
}

Write-Host "`nThen, back in the repo:" -ForegroundColor Cyan
Write-Host "  node scripts/onboarding/graph-check.mjs --mailbox rob@stemplusc.org`n"

Disconnect-ExchangeOnline -Confirm:$false
