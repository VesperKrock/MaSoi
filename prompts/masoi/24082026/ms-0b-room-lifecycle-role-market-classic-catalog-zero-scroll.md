# MS-0B — Room Lifecycle + Role Market + Classic Catalog + Player Zero-Scroll

## Mission

Turn the MS-0A technical foundation into the first truthful MaSoi product flow.

MS-0A proved:

* game-domain separation
* Moderator/Player projections
* local room transport
* night-call contract
* wolf resolution
* journal foundation

MS-0B must now establish:

```text
product entry
→ room configuration
→ role-market selection
→ room creation
→ room-code join
→ player-name join
→ lobby
→ explicit role assignment
→ game
```

A Player must never appear inside a seat before a room exists.

---

# Product philosophy

The permanent MaSoi product contract remains:

> **Không thay thế boardgame.**
>
> **Thay thế bộ bài giấy và trí nhớ của quản trò.**

And:

> **Người chơi nhìn nhau. Quản trò nhìn app.**

Phones remain companions to the physical game.

---

# Absolute UI distinction

## Player / participant surfaces

Player-facing UX must be:

```text
mobile-first
single-screen
zero-scroll
quiet
function-first
```

## Moderator surfaces

Moderator UX may be:

```text
information-dense
scrollable
portrait
landscape
responsive
```

Do not apply Player layout restrictions to Moderator.

---

# Repository truth first

Before modifying source:

```text
pwd
find . -maxdepth 3 -type f | sort
git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
```

If Git does not exist, report it.

Inspect the current implementation from MS-0A.

Do not reset MS-0A work.

Do not rewrite the game engine unnecessarily.

Preserve the RoomTransport boundary.

---

# Asset inspection

Inspect all current card assets physically present in the repository.

The Product Owner has now supplied Classic card artwork as JPG.

Do not rely solely on historical MS-0A inventory.

Re-scan physical asset truth.

Report:

```text
asset root
Classic file count
all JPG filenames
duplicate-content groups
unique role-card count
card back
unmapped assets
```

---

# Card files are not role identities

Multiple physical JPG files may represent the same role type.

In particular:

```text
Dân Làng copies
→ one canonical role ID: villager

Ma Sói copies
→ one canonical role ID: werewolf
```

Do not create:

```text
villager-1
villager-2
villager-3
```

as separate role mechanics.

Likewise do not create:

```text
werewolf-1
werewolf-2
werewolf-3
```

Role quantity represents duplicates.

---

# Card-art product contract

Card artwork is an **identity document**.

It is not general visual decoration.

Use existing Classic card artwork only for:

```text
initial secret role reveal
explicit role re-check
future role guide/library
```

Do not use card images for:

```text
Moderator dashboard
Moderator role market
Moderator night checklist
Player neutral screen
night action UI
target selection
day vote
journal
general backgrounds
```

Moderator does not need to see role cards during normal operation.

---

# Canonical Classic catalog

Create one canonical role-catalog source.

Suggested concepts:

```ts
type RoleCatalogEntry = {
  id: string;
  displayName: string;
  assetAliases: string[];
  factionGroup: string;
  quantityMode: "MULTIPLE" | "SINGLE";
  rulesText: string;
  notes?: string[];
};
```

Exact structure may follow repository conventions.

Do not put full mechanics in React components.

---

# Classic catalog truth

The supplied Classic deck contains 32 unique role identities.

The descriptions below establish **catalog/product meaning**.

They do not automatically define full engine implementation.

---

## Dân Làng

### Dân Làng

```text
Bạn là một Dân làng bình thường.

Phe:
Dân làng
```

Quantity mode:

```text
MULTIPLE
```

---

### Bà Già Khó Tính

```text
Một lần trong trò chơi,
có thể ép tất cả mọi người phải thức dậy ngay
để bàn luận và bầu chọn.

Phe:
Dân làng
```

Quantity:

```text
SINGLE
```

---

### Bảo Vệ

```text
Mỗi đêm có thể bảo vệ một người.

Không thể bảo vệ cùng một người
hai đêm liên tiếp.

Card text also states:
không thể bảo vệ Anh Hùng.

Phe:
Dân làng
```

Important:

```text
Anh Hùng is referenced by the card
but no corresponding Classic role is currently present.
```

Do not silently reinterpret this reference.

---

### Anh Chàng Đẹp Trai

Asset alias may currently include:

```text
Handsome.jpg
```

Card title:

```text
Anh Chàng Đẹp Trai
```

Rule meaning:

```text
Một lần trong trò chơi,
nếu bị Dân làng treo cổ,
người chơi sống sót
và tiết lộ vai trò của mình.

Phe:
Dân làng
```

---

### Hoa Bé Con

```text
Không thể bị treo cổ bởi Dân làng.

Phe:
Dân làng
```

---

### Lực Sĩ

```text
Một lần trong trò chơi,
nếu bị Ma Sói tấn công,
Lực Sĩ sống sót.

Sau đó phe Sói không thể tấn công bất cứ ai
vào đêm kế tiếp.

Phe:
Dân làng
```

---

### Người Gác Đêm

```text
Hai lần trong trò chơi,
có thể lựa chọn thức suốt đêm.

Dù nhìn thấy người khác thức,
không được ra hiệu hoặc nói chuyện.

Nếu vi phạm,
Quản trò có thể xử chết ngay.

Nếu đã thức đêm,
sáng hôm sau phải ngủ
và không thể tham gia bàn luận hoặc bầu chọn.

Phe:
Dân làng
```

---

### Bác Sĩ Pháp Y

Current asset alias may include:

```text
Người khám nghiệm.jpg
```

Card title:

```text
Bác Sĩ Pháp Y
```

Rule meaning:

```text
Chừng nào còn sống,
mọi người được biết cái chết của người chơi
là do phe nào gây ra vào sáng hôm sau.

Nếu Bác Sĩ Pháp Y bị giết,
mọi người được biết phe nào đã tấn công người này.

Phe:
Dân làng
```

---

### Phù phép: Câm

Current asset alias may include:

```text
Phù Phép.jpg
```

Rule:

```text
Mỗi đêm có thể chọn một người.

Người đó bị cấm nói chuyện
hoặc hành động trong ngày kế tiếp.

Card text states người đó chết ngay
nếu cố làm điều bị cấm.

Phe:
Dân làng
```

Do not reinterpret enforcement mechanics in MS-0B.

---

### Phù Thủy

```text
Có hai bình thuốc:

1 bình cứu
1 bình giết.

Bình cứu bị tiêu thụ
dù mục tiêu có thể nhận bảo vệ khác.

Không thể dùng thuốc giết
trong đêm đầu tiên.

Phe:
Dân làng
```

---

### Phú Ông

```text
Mỗi đêm có thể mua chuộc một người
để bảo vệ mình.

Người được mua chuộc
không bị tấn công trực tiếp,
nhưng sẽ chịu thay nếu Phú Ông bị tấn công.

Nếu mua chuộc nhầm:
Ma Sói,
Xã Hội Đen,
hoặc Solo,
Phú Ông chết.

Phe:
Dân làng
```

Important dangling reference:

```text
Xã Hội Đen
```

is mentioned but is not present as a current Classic role.

Do not invent it.

---

### The Thing

```text
Mỗi đêm có thể chọn một người,
vỗ vai và gọi người đó dậy.

Người được gọi lập tức nhận diện The Thing.

Nếu người đó là Sói,
The Thing chết vào đêm hôm sau.

Phe:
Dân làng
```

---

### Thám Tử

```text
Mỗi đêm chọn hai người
để biết họ cùng phe hay khác phe.

Card-listed faction concepts include:

Dân làng
Ma Sói
Solo
Thợ Săn Người
Thằng Ngố
Xã Hội Đen

Phe:
Dân làng
```

Important:

```text
Xã Hội Đen
```

is referenced but is not in the current Classic asset set.

Do not create missing mechanics.

---

### Thần Tình Yêu

```text
Trong đêm đầu tiên,
chọn hai người làm tình nhân.

Hai người sống chết có nhau.

Phe:
Dân làng và Cặp Đôi
```

Treat faction semantics as unresolved engine work.

Do not force this into a simple one-faction enum if the current domain cannot truthfully represent it.

---

### Thị Trưởng

```text
Có hai phiếu bầu trong suốt trò chơi.

Chỉ người chơi và Quản trò biết điều này.

Phe:
Dân làng
```

---

### Thợ Săn

```text
Nếu chết,
ngay lập tức được chọn một người.

Người đó chết theo.

Phe:
Dân làng
```

---

### Thợ Làm Bánh

```text
Vào ban đêm làm một chiếc bánh.

Không thể bị tấn công
trong đêm đang làm bánh.

Đêm sau có thể tặng bánh cho một người.

Sau đó cả hai có thể biết vai trò của nhau.

Card text states:
quá trình làm bánh cứ hai đêm một lần.

Phe:
Dân làng
```

Do not implement timing semantics yet unless explicitly required by an existing test.

---

### Tiên Tri

```text
Mỗi đêm chọn một người
để xem người đó là Ma Sói hay không.

Phe:
Dân làng
```

Existing MS-0A Seer mechanics may remain.

---

### Vệ Sĩ

```text
Mỗi đêm có thể bảo vệ một người.

Nếu người được bảo vệ
hoặc Vệ Sĩ bị tấn công,
Vệ Sĩ biết ai là người tấn công.

Sau đó Vệ Sĩ không thể bảo vệ ai nữa
và sẽ chết vào ngày hôm sau.

Card text also states:
không thể bảo vệ Anh Hùng.

Phe:
Dân làng
```

Important dangling reference:

```text
Anh Hùng
```

Do not invent the missing role.

---

# Hybrid / transforming role

## Bán Sói

```text
Bắt đầu là Dân làng.

Nếu bị Ma Sói cắn,
trở thành Ma Sói.

Card faction:
Dân Làng hoặc Ma Sói
```

Quantity:

```text
SINGLE
```

Do not reduce this to a static faction without recording the transformation semantics.

---

# Phe Ma Sói

## Ma Sói

```text
Mỗi đêm,
cùng các Ma Sói chọn một người để giết.

Phe:
Ma Sói
```

Quantity:

```text
MULTIPLE
```

Preserve MS-0A wolf-vote behavior.

---

## Kẻ Phản Bội

```text
Thức dậy cùng Ma Sói
và biết các Ma Sói là ai.

Không trực tiếp giết người.

Tiên Tri soi Kẻ Phản Bội
thì kết quả vẫn ra Dân làng.

Phe:
Ma Sói
```

---

## Sói Hộ Vệ

```text
Chừng nào còn sống,
phe Ma Sói được thoát treo cổ một lần.

Nếu hộ vệ thành công,
Sói Hộ Vệ trở thành Ma Sói bình thường.

Phe:
Ma Sói
```

---

## Sói Nguyền

```text
Một lần trong trò chơi,
sau cái chết của một Sói khác vào ban ngày,
có thể biến mục tiêu của phe Sói
thành Sói thay vì chết.

Card text states:
nếu mục tiêu có được sự bảo vệ,
có tối đa thêm một lần sử dụng khác.

Phe:
Ma Sói
```

Record wording truth.

Do not guess edge interactions yet.

---

## Sói Pháp Sư

```text
Mỗi đêm có thể yểm một người chơi khác.

Đối với Tiên Tri,
người bị yểm sẽ được soi thành Ma Sói.

Phe:
Ma Sói
```

---

## Sói Trẻ Con

```text
Nếu bị giết bởi phe Dân làng,
phe Ma Sói có thể giết hai người
vào đêm hôm sau.

Treo cổ được tính là
bị giết bởi Dân làng.

Phe:
Ma Sói
```

---

## Sói Đầu Đàn

```text
Chừng nào còn sống,
mỗi đêm phe Ma Sói
có thể giết hai người chơi.

Phe:
Ma Sói
```

---

# Solo / independent

## Kẻ Phóng Hỏa

```text
Mỗi đêm có thể:

tẩm xăng một người

hoặc

đốt tất cả những người
đã bị tẩm xăng trước đó.

Không thể bị Ma Sói giết.

Phe:
Solo
```

---

## Sát Nhân Hàng Loạt

```text
Mỗi đêm có thể giết một người.

Không thể bị Ma Sói giết.

Phe:
Solo
```

---

## Thằng Ngố

```text
Mục tiêu là lừa mọi người treo cổ mình.

Nếu bị treo cổ,
Thằng Ngố thắng.

Phe:
Thằng Ngố
```

---

## Thợ Săn Người

```text
Có một mục tiêu.

Phải khiến mục tiêu bị treo cổ để chiến thắng.

Nếu mục tiêu chết bằng cách khác,
Thợ Săn Người trở thành Dân làng bình thường.

Phe:
Thợ Săn Người hoặc Dân làng
```

Do not flatten this dynamic state in MS-0B.

---

## Kẻ Say Rượu Bia

```text
Do quá say,
đến đêm thứ hai
mới biết vai trò thật sự của mình.

Phe:
Không rõ
```

This requires future role-assignment semantics.

Do not invent what hidden role it becomes.

---

# Role grouping for setup UI

Moderator role-market may group entries as:

```text
PHE DÂN LÀNG
PHE MA SÓI
ĐỘC LẬP
ĐẶC BIỆT / CHUYỂN PHE
```

Suggested categorization:

```text
DÂN LÀNG:
all clearly Village-starting roles

MA SÓI:
all clearly Wolf-team roles

ĐỘC LẬP:
Kẻ Phóng Hỏa
Sát Nhân Hàng Loạt
Thằng Ngố
Thợ Săn Người

ĐẶC BIỆT / CHUYỂN PHE:
Bán Sói
Kẻ Say Rượu Bia
```

The exact grouping is navigation metadata.

It must not silently redefine win conditions.

---

# Quantity contract

Only two canonical roles can have quantity greater than one:

```text
Dân Làng
Ma Sói
```

All other Classic roles:

```text
0 or 1
```

Enforce this in domain validation, not only button states.

---

# Player count

Supported room size for this product scope:

```text
7–16 players
```

Moderator is not counted as a Player seat.

Examples:

```text
7 seats
→ exactly 7 selected role cards

12 seats
→ exactly 12 selected role cards

16 seats
→ exactly 16 selected role cards
```

---

# Role-market UX

The Moderator create-room screen should show:

```text
SỐ NGƯỜI
10

ĐÃ CHỌN
8 / 10
```

Then grouped role rows.

Example:

```text
PHE DÂN LÀNG

Dân Làng
[−] 3 [+]

Tiên Tri
[+ Thêm]

Bảo Vệ
[✓ Đã chọn]
```

For singleton roles:

```text
not selected
selected
```

is enough.

Do not make Moderator inspect card images.

A small text-information affordance may show the role description if useful.

It must remain text-first.

---

# Create-room validity

The create action is enabled only when:

```text
selectedRoleCount === seatCount
```

Reject invalid commands in domain as well.

Do not rely on disabled UI alone.

If:

```text
selectedRoleCount < seatCount
```

show:

```text
Còn thiếu X vai trò.
```

If somehow:

```text
selectedRoleCount > seatCount
```

show:

```text
Đang dư X vai trò.
```

---

# Product landing page

Normal app entry must no longer drop the user directly into Moderator or Player development views.

Default product landing:

```text
MA SÓI

[TẠO PHÒNG]

[VÀO PHÒNG]
```

Optional secondary links may exist later.

Do not expose seat-debug navigation as the primary experience.

---

# Room lifecycle

Introduce an explicit room lifecycle.

At minimum:

```text
CONFIGURING
LOBBY
ROLE_REVEAL
IN_GAME
FINISHED
```

If another state model better matches existing architecture, preserve equivalent truth.

Important contract:

```text
CONFIGURING
→ Moderator chooses seats/deck

CREATE
→ room receives code

LOBBY
→ Players join

LOCK & ASSIGN
→ roles shuffled and privately assigned

ROLE_REVEAL
→ Players see role

IN_GAME
→ physical game begins
```

Do not assign Player roles at room creation.

---

# Six-digit room code

Each room receives a display code with exactly six numeric digits.

Represent it as a string.

Example:

```text
381624
```

Do not use the display code as the internal room primary key.

Use a separate internal room ID.

For the local MS-0B simulator:

```text
roomId:
internal unique ID

roomCode:
six-digit display code
```

Avoid collisions among active locally stored rooms.

---

# Important MS-0B network boundary

MS-0B still uses:

```text
LocalRoomTransport
```

Therefore six-digit room joining is only truthful for the same local browser storage/profile.

Do not claim:

```text
works across phones
works across network
production multiplayer
```

That becomes MS-1A.

However all room APIs should be designed so Supabase can replace LocalRoomTransport later without rewriting the UI flow.

---

# Join-room screen

Player entry:

```text
VÀO PHÒNG

[_] [_] [_] [_] [_] [_]

[TIẾP TỤC]
```

Requirements:

```text
digits only
exactly 6 digits
paste supported
backspace works naturally
mobile numeric keyboard
```

The UI may use one semantic input visually rendered as six slots if that improves accessibility.

Do not create six broken independent text fields solely for appearance.

---

# Validate room BEFORE asking name

This order is mandatory.

Player submits code.

System checks:

```text
room exists?
room is joinable?
room has free seat?
room has not started?
```

If invalid:

```text
show exact error
remain on room-code screen
```

Do not ask for Player name.

---

# Player-name modal

Only after room code passes validation:

```text
TÊN CỦA BẠN

[________________]

Tên này sẽ được dùng trong ván chơi.

[HỦY]

[VÀO PHÒNG]
```

This must be a modal/sheet that still respects the Player zero-scroll contract.

Do not require:

```text
account
email
password
profile
```

The Player is only choosing the visible in-game name.

---

# Name validation

Minimum truthful validation:

```text
trim whitespace
non-empty
reasonable length
```

Use a clear maximum such as:

```text
20 characters
```

Avoid unnecessary character restrictions for Vietnamese names.

Within one room, prevent exact duplicate visible names after trim/case normalization, because vote/target selection otherwise becomes ambiguous.

Return a clear error:

```text
Tên này đã có người dùng trong phòng.
```

Do not silently rename the Player.

---

# Joining

On successful join:

```text
create Player
assign stable seat
store display name
enter Lobby
```

Do not assign secret role yet.

Player lobby:

```text
PHÒNG 381624

Bảo Châu

Đã vào phòng.

Chờ Quản trò bắt đầu.
```

No scroll.

No role hints.

---

# Moderator lobby

Moderator lobby should prioritize:

```text
ROOM CODE
joined count
seat capacity
joined names
room status
```

Example:

```text
PHÒNG

381 624

7 / 10 NGƯỜI ĐÃ VÀO

01 — Bảo Châu
02 — Minh
03 — Xuka
...
```

Moderator may scroll if the display is small.

Moderator must not be forced into Player zero-scroll layout.

---

# Role assignment timing

The role deck is configured before room creation.

But actual Player-to-role assignments occur only after the Moderator explicitly starts assignment.

Button:

```text
KHÓA PHÒNG & CHIA VAI
```

or equivalent clear language.

Before execution validate:

```text
joinedPlayers === seatCount
selectedRoleCount === seatCount
room is still LOBBY
```

Then:

```text
shuffle role deck
assign exactly one role to each Player
create private assignments
transition to ROLE_REVEAL
```

---

# Shuffle

Use centralized randomness already established by MS-0A.

Do not use ad-hoc `Math.random()` in React.

Tests must permit deterministic injection.

---

# Role reveal

After assignment, Player receives their actual supplied JPG card.

This is one of the few permitted uses of card artwork.

The card should fit the screen.

No Player scroll.

The Player confirms:

```text
ĐÃ NHỚ VAI TRÒ · ÚP MÁY
```

After confirm:

```text
neutral waiting screen
```

Do not continue to display the card.

---

# No-scroll law

This is an absolute Player product requirement.

All non-Moderator Player-facing surfaces must render without vertical or horizontal scrolling.

Includes:

```text
landing
room-code input
name modal
lobby
role reveal
role re-check
neutral night screen
neutral day screen
night actions
wolf vote
Seer target selection
future role actions
day hanging vote
results shown privately to Player
```

Forbidden:

```text
body scrolling
horizontal scrolling
nested scroll regions
scrollable dialogs
scrollable dropdowns required for core action
```

---

# Player viewport contract

At minimum manually/test-layout validate:

```text
320 × 568
360 × 640
390 × 844
430 × 932
```

Portrait is primary.

Player surfaces must remain functional at the smallest supported viewport.

Use:

```text
100dvh
responsive type
responsive gaps
compact grids
```

Do not solve overflow by clipping required controls.

---

# 16-player target selection

A Player can be required to select among up to 15 other Players.

This must still require no scroll.

Use a responsive compact target grid.

Conceptually:

```text
4 columns × 4 rows
```

or another layout proven to fit.

Each option must remain touchable.

Display may prioritize:

```text
seat number
short player name
```

over unnecessary decoration.

Do not use role artwork.

---

# Moderator scroll/orientation

Moderator may:

```text
scroll vertically
use portrait
use landscape
rotate during the match
```

Moderator surfaces should reflow rather than break.

Do not artificially lock Moderator orientation.

Do not lock Moderator body overflow.

---

# Existing MS-0A dev routes

Current direct testing routes such as:

```text
?view=moderator
?view=player&seat=1
```

may remain available in development if useful for automated/manual QA.

But:

```text
they are DEV scaffolding
```

They must not appear as the standard product entry.

Normal user flow must pass through room lifecycle.

---

# Do not implement full role mechanics yet

MS-0B establishes:

```text
catalog truth
quantity
faction grouping
asset mapping
room setup
room lifecycle
```

Do not suddenly implement all 32 role mechanics.

Preserve implemented MS-0A mechanics.

Complex role behavior belongs to later dedicated gates.

This is especially important for ambiguous interactions such as:

```text
Anh Hùng reference
Xã Hội Đen reference
Cặp Đôi faction
Bán Sói conversion
Kẻ Say Rượu hidden role
Sói Nguyền protected conversion
Thợ Làm Bánh timing
Phú Ông sacrifice ordering
```

Record them.

Do not guess them.

---

# Tests — role market

Add tests proving:

```text
room accepts 7–16 seats only

Dân Làng quantity may exceed 1

Ma Sói quantity may exceed 1

every other role rejects quantity > 1

selected role total < seat count
→ cannot create

selected role total > seat count
→ cannot create

selected role total == seat count
→ can create
```

---

# Tests — asset/catalog

Prove:

```text
Dân Làng duplicate JPGs
→ one canonical role

Ma Sói duplicate JPGs
→ one canonical role

all 32 expected unique Classic role entries exist

each catalog entry has:
id
display name
group/faction metadata
quantity mode
rules text
asset mapping or explicit unresolved asset
```

Also surface known dangling references:

```text
Anh Hùng
Xã Hội Đen
```

Tests must not silently create those roles.

---

# Tests — room lifecycle

Prove:

```text
no room
→ no Player seat

create valid config
→ room created

room receives six-digit code

room starts in LOBBY after creation

no role assignments before lock/start

players can join open room

room full rejects join

started room rejects join

Moderator lock/start with missing Players rejects

Moderator lock/start with full room
→ assignments created exactly once
```

---

# Tests — join flow

Prove:

```text
invalid code
→ no name modal

nonexistent room
→ no name modal

full room
→ no name modal

started room
→ no name modal

valid open room
→ name modal opens

empty name
→ rejected

duplicate room name
→ rejected

valid name
→ Player created
```

---

# Tests — zero-scroll

Where practical, add DOM/layout contract tests for:

```text
Player shell overflow
modal overflow
role reveal shell
neutral shell
action shell
vote shell
```

Also perform browser viewport QA.

Return a matrix:

```text
SURFACE | 320×568 | 360×640 | 390×844 | 430×932 | SCROLL
```

Every Player surface must report:

```text
PASS | PASS | PASS | PASS | NO
```

Do not claim layout PASS from CSS inspection alone if browser rendering can be performed.

---

# Moderator QA

Validate Moderator at:

```text
portrait mobile
landscape mobile
desktop
```

Scrolling is allowed.

No requirement for all Moderator content to fit one viewport.

---

# Do not add

MS-0B must not add:

```text
Supabase
production backend
authentication UI
QR code join
chat
voice
TTS
notification
vibration
haptics
matchmaking
ranking
cloud match history
full role-engine implementation
```

---

# Build validation

Run:

```text
npm test
npm run lint
npm run build
```

If scripts differ, use the repository truth.

Do not hide failures.

---

# Git boundary

Do not:

```text
reset
commit
push
deploy
```

At end report, if Git exists:

```text
git status --short
git diff --stat
git diff --name-only
```

---

# Required final response

Return:

```text
MS-0B:

PASS | FAIL

BASELINE:
...

ASSET INVENTORY:
...

CLASSIC UNIQUE ROLES:
32 / <actual>

CANONICAL CARD MAPPING:
...

CATALOG NAMING ALIASES:
...

DANGLING ROLE REFERENCES:
...

ROOM LIFECYCLE:
...

LANDING:
...

CREATE ROOM:
...

ROLE MARKET:
...

ROLE QUANTITY CONTRACT:
...

ROOM CODE:
...

JOIN FLOW:
...

NAME MODAL:
...

LOBBY:
...

ROLE ASSIGNMENT TIMING:
...

PLAYER ZERO-SCROLL:
...

VIEWPORT MATRIX:
...

MODERATOR RESPONSIVE/SCROLL:
...

DEV ROUTES:
...

FILES CHANGED:
...

TESTS:
...

LINT:
...

BUILD:
...

SUPABASE:
NO

REAL CROSS-DEVICE JOIN:
NO — LOCAL TRANSPORT ONLY

COMMIT:
NO

PUSH:
NO

DEPLOY:
NO

KNOWN LIMITATIONS:
...

NEXT:
MS-1A — Supabase Room Authority + Anonymous Device Identity + Real Six-Digit Cross-Device Join
```

Do not claim PASS unless:

```text
normal product entry starts outside any room
create-room flow exists
role market enforces exact seat count
only Villager/Werewolf are multi-copy
six-digit room code exists
name modal only appears after valid code
roles are assigned only after Moderator explicitly starts
Classic catalog contains all supplied unique role identities
duplicate JPGs do not create fake roles
known dangling references are surfaced
Player surfaces demonstrate zero-scroll
Moderator remains scrollable/responsive
tests/lint/build pass or a blocking repo issue is truthfully proven
```

---

# Successful line

```text
MS-0B PASS — ROOM LIFECYCLE + CLASSIC ROLE MARKET + SIX-DIGIT JOIN FLOW + PLAYER ZERO-SCROLL CONTRACT ESTABLISHED — READY FOR SUPABASE ROOM AUTHORITY
```
