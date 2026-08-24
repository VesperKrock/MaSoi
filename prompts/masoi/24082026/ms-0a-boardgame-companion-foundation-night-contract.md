# MS-0A — Boardgame Companion Foundation + Night Contract

## Mission

Establish the first working foundation for **MaSoi** as a physical-boardgame companion.

This product is **not** intended to replace the social game with a videogame.

The product contract is:

> **Không thay thế boardgame.**
> **Thay thế bộ bài giấy và trí nhớ của quản trò.**

And:

> **Người chơi nhìn nhau. Quản trò nhìn app.**

The player device should remain intentionally passive for most of the match.

The Moderator device is the operational brain of the session.

MS-0A must create a foundation that can later receive a Supabase realtime transport **without rewriting the game domain**.

---

# Absolute product rules

The physical group remains the actual game.

Do not add:

```text
online matchmaking
public lobby
accounts
profiles
chat
voice chat
automatic narration
TTS
push notifications
browser notifications
vibration
haptics
player turn sounds
gameplay music
forced discussion countdowns
ranking
XP
coins
shop
daily rewards
combat-like animations
```

Do not make players stare at their phones.

A player should normally touch the device only for:

```text
initial secret role reveal
secret role action when Moderator calls that role
daytime hanging vote
explicit role re-check if later implemented
```

Everything else happens physically around the table.

---

# Repository first

Before changing files, inspect physical repository truth.

Run as applicable:

```text
pwd
find . -maxdepth 2 -type f | sort
git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
```

If the directory is not currently a Git repository, report that fact.

Do not invent a remote baseline.

Do not reset existing work.

Do not overwrite unrelated files.

Do not delete or destructively rename existing card images.

Inspect existing asset/card folders.

If Classic card images already exist, preserve the original files and build a manifest around them rather than changing the originals merely to simplify code.

Physical repo truth wins over assumptions in this prompt.

---

# Framework

If the project already has a coherent frontend stack:

```text
preserve it
```

If the project is essentially new and has no frontend framework:

```text
Vite
React
TypeScript
```

Use a simple maintainable styling approach.

Do not introduce a large UI framework solely for this gate.

The app should be mobile-first but remain usable in desktop development.

---

# Architecture requirement

Game rules must not live inside React components.

Separate at minimum:

```text
domain / game engine
role definitions
session state
action resolution
journal/events
transport abstraction
local development transport
UI
```

An acceptable direction is:

```text
src/
  domain/
    game/
    roles/
    actions/
    voting/
    journal/

  transport/
    room-transport.ts
    local/

  state/

  views/
    moderator/
    player/

  components/

  assets/
```

Exact naming may differ if the repository already establishes conventions.

What matters is separation of responsibility.

---

# Future Supabase boundary

Do **not** implement Supabase in MS-0A.

However, do not couple the game engine directly to:

```text
localStorage
BroadcastChannel
React state
DOM
```

Create an abstraction such as:

```ts
interface RoomTransport {
  getSnapshot(): Promise<RoomSnapshot>;
  subscribe(listener: (snapshot: RoomSnapshot) => void): () => void;
  dispatch(command: RoomCommand): Promise<void>;
}
```

The exact API may differ.

The requirement is:

```text
game/domain contract
        ↓
RoomTransport
        ↓
LocalRoomTransport       MS-0A
SupabaseRoomTransport    future gate
```

The future Supabase adapter must be replaceable without rewriting role logic.

---

# Local development transport

For this gate, implement a development transport that allows Moderator and Player surfaces to be tested in multiple browser tabs.

Preferred browser primitives:

```text
BroadcastChannel
+
localStorage or equivalent durable local snapshot
```

This is a development simulator.

Do not claim it provides production security or cross-device networking.

Provide a simple way to open:

```text
Moderator
Player seat 1
Player seat 2
Player seat 3
...
```

in separate tabs and observe synchronized local state.

---

# Session identities

Separate public player identity from secret role assignment.

Conceptually:

```ts
type Player = {
  id: string;
  seat: number;
  alias: string;
  alive: boolean;
};
```

Secret assignment must be modeled separately:

```ts
type RoleAssignment = {
  playerId: string;
  roleId: string;
};
```

Do not build UI around:

```text
player.role
```

as a casually public property.

Future server security will need a private-assignment boundary.

---

# Player naming

Do not require players to type a real name in MS-0A.

Generate a friendly alias automatically.

Example style:

```text
Ếch
Cáo
Gấu
Thỏ
Mèo
Rái Cá
Gấu Mèo
Cánh Cụt
```

Also keep a stable seat number.

Example:

```text
04 — Thỏ
```

Alias generation must avoid duplicates inside the same room.

Architecture may allow manual names later, but manual naming is not required now.

---

# Moderator is not a game role

The Moderator is a room participant/operator.

Do not include Moderator in faction victory logic.

Conceptually distinguish:

```text
PLAYER
MODERATOR
```

from actual game roles such as:

```text
WEREWOLF
SEER
PROTECTOR
WITCH
VILLAGER
```

---

# Role definitions

Roles must be data-driven.

Do not scatter role metadata through screens.

A role definition may contain concepts such as:

```ts
id
displayName
team
cardAsset
actsAtNight
nightOrder
firstNightOnly
actionType
targetRules
resolutionRules
description
instructions
```

Do not require every future Classic role to be implemented in MS-0A.

Implement enough roles to prove the architecture.

At minimum support domain definitions required for the vertical foundation:

```text
Werewolf
Seer
Villager
```

Generic target-action infrastructure should be reusable by future roles such as Protector and Witch.

If matching card assets exist, connect them through the manifest.

Do not invent missing image files.

---

# Role reveal

A Player must be able to receive an initial secret role reveal.

After confirmation, the Player returns to a neutral game surface.

Role reveal is separate from normal night actions.

Do not leave the role card permanently visible during normal play.

---

# Neutral player screen

This is a critical product requirement.

When no action is currently available to a Player, their screen should look substantially the same as every other Player screen in the same public phase.

Night example:

```text
ĐÊM 2

Hãy úp điện thoại xuống.
Lắng nghe Quản trò.
```

Day example:

```text
NGÀY 2

Thảo luận cùng mọi người.
```

Do not show:

```text
your role
your faction
your night order
“your turn soon”
role-specific standby text
secret status
```

while waiting.

No vibration.

No haptic feedback.

No notification.

No sound.

No automatic voice.

---

# Moderator controls pacing

The app must never automatically control the physical table rhythm.

Moderator decides when the next role is called.

Do not implement:

```text
Werewolf completes
→ automatically wake Seer
```

Instead:

```text
Werewolf completes
→ Moderator sees completion
→ Moderator decides when to continue
→ Moderator calls next role
```

Human narration controls the actual pace.

---

# Night call dashboard

Create a Moderator night dashboard centered around a simple call checklist.

The main visual contract should resemble:

```text
ĐÊM 1

Ma Sói      [Đã gọi]
Tiên Tri    [Chưa gọi]
Bảo Vệ      [Chưa gọi]
Phù Thủy    [Chưa gọi]
```

The primary state requested by the Moderator is:

```text
CHƯA GỌI
ĐÃ GỌI
```

Internal engine state may be more detailed, for example:

```text
NOT_CALLED
CALLED
WAITING_FOR_ACTION
ACTION_COMPLETE
CLOSED
```

but do not force that complexity onto the main dashboard.

---

# Critical secrecy rule — dead roles are still called

This is mandatory.

The Moderator must call every configured nighttime role according to the ritual sequence **even if all holders of that role are already dead**.

Example:

```text
Day 1:
Seer dies.

Night 2 Moderator dashboard:

Werewolf    [Chưa gọi]
Seer        [Chưa gọi]
Witch       [Chưa gọi]
```

The Seer entry must still exist.

The system must not:

```text
remove Seer
gray Seer out as dead
mark Seer “not required”
auto-skip Seer
jump over Seer
shorten the sequence because Seer is dead
```

Why:

```text
Skipping a dead role leaks the dead player's hidden identity
through Moderator behavior.
```

---

# Calling a role with no living holder

Expected flow:

```text
Moderator says physically:
“Tiên Tri hãy tỉnh dậy.”

Moderator presses:
GỌI TIÊN TRI
```

If a living Seer exists:

```text
that Player receives the Seer action surface
```

If no living Seer exists:

```text
no Player receives an action surface
```

But the Moderator can still mark/confirm:

```text
Tiên Tri — Đã gọi
```

and continue the physical ritual normally.

Do not reveal on the main Moderator sequence that the role had no living holder.

Detailed private diagnostics may exist elsewhere for the Moderator, but must never alter the standard call rhythm.

---

# Player activation contract

When Moderator calls a role:

```text
Moderator physically speaks first
        ↓
Moderator presses GỌI
        ↓
eligible living holder receives action UI silently
```

There must be:

```text
no vibration
no sound
no notification
no toast saying “your turn”
```

The player knows to look because the Moderator just called the role aloud.

The action UI may appear immediately.

After the player confirms/closes the action:

```text
return immediately to neutral night screen
```

---

# Action eligibility

Only an eligible living Player should receive an actionable role surface.

Dead holders must remain neutral.

Other Players remain neutral.

For roles with multiple living holders, all eligible holders may receive the role-specific action according to that role's resolver.

---

# Moderator action visibility

Moderator should be able to see completed secret actions because the product is replacing Moderator memory.

Example after Seer completes:

```text
Tiên Tri
Đã gọi
Đã hoàn thành

Đã chọn:
04 — Thỏ
```

Do not expose this to Player clients.

---

# Werewolf voting model

The Werewolf action must support more than exactly two wolves.

Do not hard-code:

```text
wolfA
wolfB
```

Model:

```text
N living eligible Werewolves
```

Each living wolf can hold either:

```text
one target vote
or
ABSTAIN
```

ABSTAIN means:

> **trung lập**

It is not a vote against the current target.

---

# Critical abstain rule

Example:

```text
Wolf A → Bảo Châu
Wolf B → ABSTAIN
```

Result:

```text
Bảo Châu
```

This must **not** be treated as a tie.

The interpretation is equivalent to:

> “Thôi bro chọn đi.”

One wolf choosing nobody does not cancel another wolf's valid choice.

---

# General wolf vote calculation

Ignore abstentions when counting positive target votes.

Example:

```text
A → Châu
B → Châu
C → ABSTAIN
```

Result:

```text
Châu
```

Example:

```text
A → Châu
B → Minh
C → ABSTAIN
```

Positive vote result:

```text
Châu 1
Minh 1
```

This is a tie.

Example:

```text
A → Châu
B → Châu
C → Minh
```

Result:

```text
Châu
```

No revote is required.

---

# Eligible wolf targets

Create target eligibility as a rule function/configuration rather than spreading filtering logic throughout components.

For the initial Classic behavior, living non-wolf players may be used as eligible victims unless physical existing rules in the repository establish otherwise.

Keep this replaceable for future variants.

---

# Wolf resolution policy A — RANDOM_ON_TIE

Support room policy:

```text
RANDOM_ON_TIE
```

Resolution:

### Unique positive leader

Example:

```text
A → Châu
B → ABSTAIN
```

Result:

```text
Đã chọn: Bảo Châu
```

### Positive tie

Example:

```text
A → Châu
B → Minh
```

Random only between:

```text
Châu
Minh
```

Do not random across the entire village.

Moderator result:

```text
Đã chọn ngẫu nhiên: Bảo Châu
```

### All living wolves abstain

Example:

```text
A → ABSTAIN
B → ABSTAIN
```

There is no positive vote.

For the current rule, choose randomly from the eligible wolf targets.

Moderator result:

```text
Đã chọn ngẫu nhiên: Bảo Châu
```

Record that the random fallback came from an all-abstain state.

---

# Wolf resolution policy B — REVOTE_10S

Support room policy:

```text
REVOTE_10S
```

If the first vote produces a unique positive leader:

```text
resolve immediately
```

No timer.

If the first vote produces a positive tie:

```text
open a 10-second revote
```

Only the tied targets from the first round are eligible during this revote.

Example first round:

```text
A → Châu
B → Minh
```

Revote candidates:

```text
Châu
Minh
```

The player may change their vote at any time while the revote is open.

ABSTAIN remains allowed.

---

# Revote resolution

During the 10-second revote:

### Unique leader

Example:

```text
A → Châu
B → ABSTAIN
```

Result:

```text
Đã chọn: Bảo Châu
```

The abstaining wolf is neutral.

Do not call this a tie.

### Consensus

Example:

```text
A → Minh
B → Minh
```

Result:

```text
Đã chọn: Minh
```

The resolver may finish early when the outcome is unambiguously resolved.

### Still tied at deadline

Example:

```text
A → Châu
B → Minh
```

At 00:00:

```text
random among current top tied candidates
```

Moderator sees:

```text
Đã chọn ngẫu nhiên: Bảo Châu
```

### Everyone abstains during revote

Example:

```text
A → ABSTAIN
B → ABSTAIN
```

At deadline:

```text
random among the initial tied candidates
```

Do not expand the random pool back to the entire village.

---

# Wolf result presentation

Regardless of how complicated the resolver was internally, the Moderator must receive one clear final target.

Normal:

```text
ĐÃ CHỌN:
BẢO CHÂU
```

Random fallback:

```text
ĐÃ CHỌN NGẪU NHIÊN:
BẢO CHÂU
```

Detailed resolution may exist behind an optional details panel.

Example:

```text
Round 1
Wolf 01 → Bảo Châu
Wolf 02 → Minh Anh

Result:
Tie

Revote
Wolf 01 → Bảo Châu
Wolf 02 → Minh Anh

Result:
Tie at timeout

Random fallback:
Bảo Châu
```

The Moderator should not need to inspect these details during normal play.

---

# Randomness

Centralize random selection.

Do not call `Math.random()` independently throughout UI components.

Provide a resolver/random service that can be replaced or seeded in tests.

Unit tests must be deterministic.

---

# Basic daytime hanging vote

Implement the minimum daytime voting surface.

Moderator controls:

```text
MỞ BỎ PHIẾU
ĐÓNG BỎ PHIẾU
```

Living Players may:

```text
select one eligible living player
change selection while vote is open
```

Do not force a countdown.

Do not auto-close.

Do not auto-narrate.

When Moderator closes voting:

### Unique top

Return:

```text
Đề xuất treo cổ:
04 — Thỏ
```

### Tie

Return the tie clearly.

Do not invent a house rule.

Example:

```text
HÒA PHIẾU

04 — Thỏ: 3
07 — Cáo: 3
```

Moderator decides what happens next.

Moderator authority remains final.

---

# Moderator override

Design domain support for Moderator override.

The Moderator is the final authority of the physical game.

The app may compute:

```text
target
death
vote result
```

but Moderator must be able to override a result deliberately.

Every override must enter the journal.

Example event:

```text
MODERATOR_OVERRIDE
from: alive
to: dead
player: 04 — Thỏ
reason: optional text
```

The full override UI can remain minimal in MS-0A, but the domain model must support it.

---

# Journal / event log

The system must record enough structured events to reconstruct a match.

At minimum:

```text
room created
role assigned
role call
role action opened
role action submitted
target selected
wolf vote
wolf abstain
wolf tie
wolf revote started
wolf revote changed
wolf random resolution
day vote opened
day vote changed
day vote closed
hanging result
player death
Moderator override
phase change
match end
```

Each event should include as applicable:

```text
event id
timestamp
day number
phase
actor player
actor role
target player
resolution
metadata
```

Do not build the final polished journal UI yet if it expands scope too much.

But provide a readable development view or data inspector proving that journal events exist.

---

# Secret/public data discipline

Even though MS-0A uses a local development transport, structure state so future realtime security is possible.

Player-facing snapshots should not casually expose:

```text
all role assignments
other players' private actions
Seer results
wolf votes
Moderator-only journal detail
```

Do not claim this local simulator is secure against DevTools.

The goal in MS-0A is architectural separation.

True client/server secrecy will be a later Supabase + RLS gate.

---

# Classic asset inventory

Inspect the existing Classic assets.

Return:

```text
asset folders found
number of assets
recognized role/card mapping
unmapped files
back-card asset if present
```

Do not rename originals merely for cleaner IDs.

Prefer a manifest:

```ts
roleAssetManifest = {
  werewolf: "...",
  seer: "...",
  ...
}
```

If a filename is ambiguous, leave it explicitly unmapped rather than guessing.

---

# Visual direction

Keep the visual experience restrained.

Desired traits:

```text
dark
clear
mobile-first
high readability
boardgame companion
minimal motion
large Moderator controls
simple Player surfaces
```

Avoid:

```text
arcade HUD
combat effects
achievement visuals
glowing “YOUR TURN”
excessive timers
gaming dashboards on Player devices
```

The Moderator interface may contain more operational information.

The Player interface should remain intentionally boring while idle.

That is a feature.

---

# Tests

Add focused tests for pure game logic.

At minimum prove:

## Dead-role call secrecy

```text
Seer assigned
Seer dies
next night still contains Seer call step
Moderator can mark Seer called
no Player receives Seer action
sequence continues normally
```

## One wolf vote + one abstain

```text
A → Châu
B → ABSTAIN

=> Châu
```

## Majority with abstain

```text
A → Châu
B → Châu
C → ABSTAIN

=> Châu
```

## Tie / random policy

```text
A → Châu
B → Minh

=> random only from [Châu, Minh]
```

## All abstain / random policy

```text
A → ABSTAIN
B → ABSTAIN

=> random from eligible targets
```

## Revote with one abstain

Initial:

```text
A → Châu
B → Minh
```

Revote:

```text
A → Châu
B → ABSTAIN
```

Result:

```text
Châu
```

## Revote still tied

Initial:

```text
A → Châu
B → Minh
```

Revote deadline:

```text
A → Châu
B → Minh
```

Result:

```text
random only from current tied targets
```

## Revote all abstain

Initial tied candidates:

```text
Châu
Minh
```

Revote:

```text
A → ABSTAIN
B → ABSTAIN
```

Result:

```text
random from initial tied candidates
```

## N wolves

Include at least one 3-wolf test proving the resolver is not hard-coded to two wolves.

---

# Build and validation

Run the repository's available checks.

If applicable:

```text
npm test
npm run lint
npm run build
```

Do not hide failures.

Classify:

```text
new regression
pre-existing issue
environment issue
missing script
```

Do not weaken tests just to obtain green output.

---

# Manual local QA

Provide exact local QA steps for multiple tabs.

Minimum walkthrough:

```text
1. Open Moderator.
2. Create/reset a development room.
3. Open several Player tabs.
4. Assign/reveal roles.
5. Confirm all idle Players show the same neutral night surface.
6. Moderator calls Werewolf.
7. Only living Werewolf tabs receive wolf action.
8. Submit split wolf votes.
9. Prove selected tie policy.
10. Moderator calls Seer.
11. Only living Seer receives action.
12. Kill Seer through dev control or Moderator override.
13. Start next night.
14. Prove Seer still appears as CHƯA GỌI.
15. Call Seer.
16. Prove no Player receives action.
17. Mark/confirm ĐÃ GỌI.
18. Continue sequence.
19. Open daytime vote.
20. Submit votes.
21. Close vote.
22. Inspect journal.
```

---

# Out of scope

Do not implement in MS-0A:

```text
Supabase
RLS
production multiplayer
QR join
room codes over internet
authentication
reconnection
offline PWA caching
voice narration
recorded Moderator audio
Google TTS
full Classic role catalog
complex Witch mechanics
Cupid lovers
Hunter death shot
special wolf variants
win-condition catalog
online discussion mode
online chat
spectators
statistics
match history cloud persistence
```

Those belong to later gates.

---

# Git boundary

Do not:

```text
reset existing work
commit
push
deploy
```

At the end show:

```text
git status --short
git diff --stat
git diff --name-only
```

if Git exists.

---

# Required final answer

Return:

```text
MS-0A:

PASS | FAIL

REPOSITORY BASELINE:
...

STACK:
...

ASSET INVENTORY:
...

FILES CHANGED:
...

ARCHITECTURE:
...

ROOM TRANSPORT:
...

MODERATOR VIEW:
...

PLAYER VIEW:
...

NIGHT CALL CONTRACT:
...

DEAD ROLE CALL PROOF:
...

WEREWOLF RESOLVER:
...

ABSTAIN SEMANTICS:
...

RANDOM_ON_TIE:
...

REVOTE_10S:
...

DAY VOTE:
...

JOURNAL:
...

TESTS:
...

BUILD:
...

LOCAL MULTI-TAB QA:
...

KNOWN LIMITATIONS:
...

SUPABASE USED:
NO

CHAT:
NO

VOICE/TTS:
NO

VIBRATION/HAPTICS:
NO

COMMIT:
NO

PUSH:
NO

DEPLOY:
NO

NEXT:
<smallest exact next gate>
```

Do not claim PASS unless:

```text
project builds or blocking reason is explicitly proven
local Moderator/Player foundation exists
night call state exists
dead role is still called
player idle screens remain neutral
wolf abstain semantics are correct
both wolf tie policies are implemented
resolver supports N wolves
journal records resolution
tests prove the critical rules
```

---

# Successful line

```text
MS-0A PASS — BOARDGAME COMPANION FOUNDATION + NIGHT CALL CONTRACT + WOLF RESOLUTION ESTABLISHED — READY FOR MODERATOR UX VERTICAL SLICE
```
