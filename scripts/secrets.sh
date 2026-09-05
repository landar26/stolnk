#!/bin/bash
#
# The Worker's secrets, in every place they live.
#
#   ./scripts/secrets.sh init                 write a fresh .dev.vars for local development
#   ./scripts/secrets.sh check  [live|test]   report what the Worker is missing or has wrong
#   ./scripts/secrets.sh push   [live|test]   overwrite the Worker from .prod.vars / .dev.vars
#   ./scripts/secrets.sh verify [live|test]   ask the deployed site which checkout it is selling
#   ./scripts/secrets.sh mode                 report which payment mode the deployed site is in
#
# The mode argument defaults to `live`, so a command typed without one means
# exactly what it has always meant.
#
# There are two kinds of secret. Generated secrets are created by `init` and
# stored only in the git-ignored .dev.vars file. SESSION_SECRET is the only one —
# it signs session tokens, and replacing it makes every device re-authenticate,
# which the Mac app does silently against its Secure Enclave key.
#
# Supplied secrets come from somewhere else and cannot be invented: the Creem
# pair is issued by Creem (PRD 16.5).
#
# TWO FILES, AND WHICH ONE `push` READS IS THE WHOLE POINT OF THIS ONE.
# .prod.vars is the deployed Worker selling for real; that is what `push` means
# with no argument, and it is the only file SESSION_SECRET is ever taken from.
# .dev.vars is the other side of the money: normally the stub Creem that
# scripts/e2e.ts starts, and — when it is pointed at Creem's test store instead
# — the source for the deliberate `push test` that puts stolnk.com in test
# payment mode.
#
# That second job is new and it is the dangerous one, because it is how the
# original bug happened: while one file served development and production both,
# `push` uploaded CREEM_CHECKOUT_BASE="https://www.creem.io/test/payment" to the
# live Worker and the buy button sold nothing for as long as nobody looked. So
# .dev.vars does not become pushable, exactly four keys of it do:
#
#   - only `push test` reads it, and the mode has to be typed out;
#   - only the CREEM_ keys are sent. SESSION_SECRET is filtered out rather than
#     merely unused, so a mode switch cannot rotate the token signing key and
#     sign every device in the field out on the way past;
#   - the stub's own values are refused. A Worker runs on Cloudflare's edge and
#     cannot fetch 127.0.0.1, so pushing .dev.vars as `init` writes it would give
#     a checkout that takes test cards in front of an activation endpoint that
#     503s every one of them;
#   - `push live` puts it all back, and refuses a .prod.vars that so much as
#     mentions the overrides.
#
# What stays forbidden is arriving in test mode without having said so, which is
# also why every default here is live.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEV_FILE=.dev.vars
LIVE_FILE=.prod.vars

# Every secret the Worker reads from its environment. Anything that is the same
# for every deploy and is not sensitive belongs in src/shared/site-origin.ts or
# wrangler.json instead, not here.
GENERATED=(SESSION_SECRET)

# Read from Creem's dashboard (PRD 16.5). The API key authenticates us to Creem;
# the webhook secret is the only thing standing between the refund endpoint and
# anyone who can POST to it. Both differ between Creem's live and test stores —
# a test-mode key is `creem_test_...` — which is why switching modes is a push
# of new values and not a flag.
#
# The product id and discount code are not sensitive — the buyer reads both off
# the checkout URL — and by the comment above they would belong in wrangler.json.
# They are here anyway, because `wrangler types` gives a var the literal type of
# its value, so an unset one types as `""` and every `if (!env.X)` guard in the
# code becomes statically dead. One mechanism for all four is worth more than
# the distinction.
#
# CREEM_DISCOUNT_CODE is optional: unset simply means the early-bird run
# (PRD 16.1) is over and checkout goes to the full price.
SUPPLIED=(CREEM_API_KEY CREEM_WEBHOOK_SECRET CREEM_PRODUCT_ID CREEM_DISCOUNT_CODE)

# Absent is a valid state for these, so `check` reports them without counting
# them as missing.
OPTIONAL=(CREEM_DISCOUNT_CODE)

# The two vars that decide which Creem the Worker talks to, and so the whole of
# what "payment mode" means here. Unset, lib/creem.ts and routes/checkout.ts fall
# back to api.creem.io and www.creem.io/payment: live mode is not a value, it is
# the absence of one. That asymmetry is why going back to live has to delete
# them — `wrangler secret bulk` only ever creates and overwrites, so leaving them
# out of .prod.vars does nothing on its own.
#
# They travel together. One without the other means activation talks to one
# Creem while the buy button sells through the other, which is the one state
# neither `push` nor `check` will call acceptable.
OVERRIDES=(CREEM_API_BASE CREEM_CHECKOUT_BASE)

SECRETS=("${GENERATED[@]}" "${SUPPLIED[@]}")

# The apex origin, duplicated from src/shared/site-origin.ts. `verify` is a
# shell script and cannot import a TypeScript constant; a wrong value here
# makes verify fail loudly rather than pass wrongly, which is the safe way for
# the copy to drift.
SITE_ORIGIN="https://stolnk.com"

MODE=live

# The filtered copy of .dev.vars that `push test` hands to wrangler. It holds
# live API credentials for as long as that call takes, so it is removed on the
# way out however the script leaves — including the `set -e` exit that a failed
# `wrangler secret bulk` produces.
PAYLOAD=""
# Returns 0 unconditionally: an EXIT trap that ends on a failed test would hand
# the caller the wrong status, and `verify` is read for its status.
shred_payload() {
	[ -n "$PAYLOAD" ] && rm -f "$PAYLOAD"
	return 0
}
trap shred_payload EXIT
trap 'shred_payload; exit 130' INT TERM

# Modes are spelled out rather than flagged. `push test` reads as a decision;
# `push --test` reads as a detail, and this is not a detail.
set_mode() {
	case "${1:-live}" in
		live | test) MODE="${1:-live}" ;;
		*)
			echo "unknown mode: $1 (expected live or test)" >&2
			exit 2
			;;
	esac
}

mode_file() {
	if [ "$MODE" = test ]; then echo "$DEV_FILE"; else echo "$LIVE_FILE"; fi
}

# What to tell the reader to run to get into $MODE. `npm run` needs the `--`
# to pass an argument through to the script.
push_hint() {
	if [ "$1" = test ]; then echo "npm run secrets:push -- test"; else echo "npm run secrets:push"; fi
}

generate() { openssl rand -base64 32; }

# `wrangler secret list` prints a JSON array of {name, type}.
remote_names() {
	npx wrangler secret list 2>/dev/null |
		python3 -c 'import json,sys
raw = sys.stdin.read()
start = raw.find("[")
print("\n".join(e["name"] for e in json.loads(raw[start:] if start >= 0 else "[]")))' 2>/dev/null || true
}

# A key is "filled in" only if it is present AND its value is not empty. The
# placeholder files this repo ships have empty Creem values on purpose, and
# pushing those would be worse than pushing nothing: activation would 503 and
# every webhook would be rejected, both of them quietly.
value_of() {
	sed -n "s/^$1=//p" "$2" | head -1 | sed 's/^"//; s/"$//'
}

# The one question that cannot be faked. Secret values are write-only once they
# reach the Worker, so the honest thing to ask is not "what did we push" but
# "what does the buy button do", and the answer is a header on a live request.
#
# `|| true` because curl -f exits non-zero on the 404 that an unset
# CREEM_PRODUCT_ID produces, and under `set -e` that would kill the script
# before it could say so.
checkout_location() {
	curl -fsS -o /dev/null -D - -m 20 "$SITE_ORIGIN/api/v1/checkout" 2>/dev/null |
		tr -d '\r' | sed -n 's/^[Ll]ocation: //p' | tail -1 || true
}

classify_location() {
	case "$1" in
		"") echo none ;;
		*/test/*) echo test ;;
		https://www.creem.io/payment/*) echo live ;;
		*) echo unknown ;;
	esac
}

cmd_init() {
	if [ -f "$DEV_FILE" ]; then
		echo "$DEV_FILE already exists — delete it first to regenerate" >&2
		exit 1
	fi
	{
		echo "# Generated by scripts/secrets.sh. The live Worker reads .prod.vars."
		for name in "${GENERATED[@]}"; do echo "$name=\"$(generate)\""; done
		echo
		echo "# Local development points at the stub Creem that scripts/e2e.ts"
		echo "# starts, so the purchase path can be exercised without an account and"
		echo "# without charging anything. With the stub not running, activation"
		echo "# fails with 503 and every device behaves as Free — which is also a"
		echo "# realistic thing to develop against."
		echo "#"
		echo "# The four CREEM_ values below are also what \`secrets.sh push test\`"
		echo "# sends, and 127.0.0.1 is not reachable from Cloudflare's edge. To put"
		echo "# the deployed site in test payment mode, replace them with Creem's"
		echo "# test store (API base https://test-api.creem.io) first; \`push test\`"
		echo "# refuses the stub rather than deploying something that cannot work."
		echo "# Undo with: rm .dev.vars && npm run secrets:init"
		echo "CREEM_API_KEY=\"dev\""
		echo "CREEM_API_BASE=\"http://127.0.0.1:5199\""
		echo "CREEM_CHECKOUT_BASE=\"https://www.creem.io/test/payment\""
		echo "CREEM_PRODUCT_ID=\"dev-product\""
		echo "CREEM_DISCOUNT_CODE=\"\""
		echo "CREEM_WEBHOOK_SECRET=\"$(generate)\""
	} > "$DEV_FILE"
	echo "wrote $DEV_FILE — local development only, never pushed"
}

cmd_check() {
	set_mode "${1:-}"
	local present
	present="$(remote_names)"
	local missing=0
	for name in "${SECRETS[@]}"; do
		if grep -qx "$name" <<<"$present"; then
			echo "  set      $name"
		elif [[ " ${OPTIONAL[*]} " == *" $name "* ]]; then
			echo "  unset    $name (optional)"
		else
			echo "  MISSING  $name"
			missing=$((missing + 1))
		fi
	done

	# Presence is the signal here, not absence, and this is the check that would
	# have caught the live site selling through Creem's test store: every secret
	# above was set, so the old `check` reported all green while
	# CREEM_CHECKOUT_BASE quietly overrode the production default.
	#
	# It cannot be a plain failure any more, because test mode is now a thing
	# someone can mean. So it compares against the mode that was asked for.
	local overridden=0
	for name in "${OVERRIDES[@]}"; do
		if grep -qx "$name" <<<"$present"; then overridden=$((overridden + 1)); fi
	done

	local actual=split
	if [ "$overridden" -eq 0 ]; then
		actual=live
	elif [ "$overridden" -eq "${#OVERRIDES[@]}" ]; then
		actual=test
	fi

	local wrong=0
	if [ "$actual" = split ]; then
		echo "  BROKEN   only one of ${OVERRIDES[*]} is set"
		echo "           activation and the buy button are talking to different Creems"
		wrong=1
	elif [ "$actual" = "$MODE" ]; then
		echo "  mode     $actual payment (expected)"
	elif [ "$actual" = test ]; then
		echo "  WRONG    the Worker is in TEST payment mode — the buy button collects no money"
		wrong=1
	else
		echo "  WRONG    the Worker is in LIVE payment mode — a test purchase charges a real card"
		wrong=1
	fi

	[ "$missing" -eq 0 ] || echo "$missing secret(s) missing — run: $(push_hint "$MODE")"
	[ "$wrong" -eq 0 ] || echo "wrong payment mode — run: $(push_hint "$MODE")"
	if [ "$missing" -eq 0 ] && [ "$wrong" -eq 0 ]; then
		if [ "$MODE" = test ]; then
			echo "run: npm run secrets:verify -- test"
		else
			echo "run: npm run secrets:verify"
		fi
	fi
	return 0
}

cmd_push() {
	set_mode "${1:-}"
	local file
	file="$(mode_file)"

	if [ ! -f "$file" ]; then
		if [ "$MODE" = test ]; then
			echo "$file not found — run: npm run secrets:init" >&2
		else
			echo "$file not found — copy $file.example and fill it in" >&2
		fi
		exit 1
	fi

	# Refuse rather than push a blank over a working value. `wrangler secret
	# bulk` would accept "" happily, and the resulting failures are quiet ones:
	# a 503 on activation, a 401 on every webhook.
	local required=(CREEM_API_KEY CREEM_WEBHOOK_SECRET CREEM_PRODUCT_ID)
	if [ "$MODE" = test ]; then
		# Without both of these, "test mode" would be a test API key pointed at
		# the live Creem: every call rejected, and the buy button still live.
		required+=("${OVERRIDES[@]}")
	else
		required=("${GENERATED[@]}" "${required[@]}")
	fi

	local blank=()
	for name in "${required[@]}"; do
		[ -n "$(value_of "$name" "$file")" ] || blank+=("$name")
	done
	if [ "${#blank[@]}" -gt 0 ]; then
		echo "$file has no value for: ${blank[*]}" >&2
		case " ${blank[*]} " in
			*" SESSION_SECRET "*) echo "SESSION_SECRET is generated, not looked up: openssl rand -base64 32" >&2 ;;
		esac
		case " ${blank[*]} " in
			*CREEM_*)
				if [ "$MODE" = test ]; then
					echo "The CREEM_ values come from Creem's dashboard with the store in TEST mode." >&2
				else
					echo "The CREEM_ values come from Creem's dashboard with the store in LIVE mode." >&2
				fi
				;;
		esac
		exit 1
	fi

	if [ "$MODE" = test ]; then
		# The stub Creem lives on 127.0.0.1 and a Worker runs on Cloudflare's
		# edge, so this is the line that decides whether .dev.vars is describing
		# local development or a deployable test store. Pushed unchanged it
		# would give a checkout that takes test cards in front of an activation
		# endpoint that cannot be reached at all — and the 503 it returns is
		# indistinguishable from Creem being down.
		local api
		api="$(value_of CREEM_API_BASE "$file")"
		case "$api" in
			https://localhost* | https://127.* | https://10.* | https://192.168.* | https://"[::1]"*) api="" ;;
			https://*) ;;
			*) api="" ;;
		esac
		if [ -z "$api" ]; then
			echo "$file points CREEM_API_BASE at $(value_of CREEM_API_BASE "$file")." >&2
			echo "The Worker fetches that from Cloudflare's edge, not from this Mac —" >&2
			echo "for a deployed test store it has to be a public https host, e.g." >&2
			echo "  CREEM_API_BASE=\"https://test-api.creem.io\"" >&2
			echo "Put the stub back (or run \`rm $file && npm run secrets:init\`) when done." >&2
			exit 1
		fi

		# A checkout base that is the live one is the original bug with the
		# labels swapped: it reads as safe and charges real cards.
		local checkout
		checkout="$(value_of CREEM_CHECKOUT_BASE "$file")"
		case "$checkout" in
			*/test/*) ;;
			*)
				echo "$file sets CREEM_CHECKOUT_BASE=$checkout, which is not a test checkout." >&2
				echo "Creem's test checkout is https://www.creem.io/test/payment." >&2
				exit 1
				;;
		esac
	else
		# The overrides have a home now, and it is not this file. Before, an
		# override left in .prod.vars was silently honoured and kept.
		for name in "${OVERRIDES[@]}"; do
			if grep -q "^$name=" "$file"; then
				echo "$file sets $name — live mode is the absence of it." >&2
				echo "Test mode goes through $DEV_FILE: $(push_hint test)" >&2
				exit 1
			fi
		done
	fi

	# Wrangler accepts dotenv files directly. Every key in the file is created
	# or overwritten in one request; remote keys absent from the file are kept.
	#
	# It takes a whole file, though, and .dev.vars has a line that must never
	# reach the Worker. So test mode pushes a filtered copy: the CREEM_ keys and
	# nothing else, which is the difference between "this file is pushable" and
	# "these four values are". .prod.vars goes up whole, because there the guard
	# above has already established that everything in it belongs there — and a
	# filter would silently drop a secret added to the file but not to this
	# script.
	local payload="$file"
	if [ "$MODE" = test ]; then
		payload="$(mktemp "${TMPDIR:-/tmp}/stolnk-secrets.XXXXXX")"
		PAYLOAD="$payload"
		chmod 600 "$payload"
		for name in "${SUPPLIED[@]}" "${OVERRIDES[@]}"; do
			sed -n "/^$name=/{p;q;}" "$file" >> "$payload"
		done
	fi

	npx wrangler secret bulk "$payload" >/dev/null
	if [ "$MODE" = test ]; then
		echo "pushed the CREEM_ values from $file (${#SUPPLIED[@]} + ${#OVERRIDES[@]} keys; SESSION_SECRET left alone)"
	else
		echo "pushed all values from $file"
	fi

	# ...which is why this loop exists. "Kept" is the wrong behaviour for the
	# overrides: leaving them out of .prod.vars is not the same as removing them
	# from the Worker, and while they survive, the Worker keeps selling through
	# Creem's test store no matter what else was just pushed. In test mode the
	# file carries them, so nothing here matches and nothing is deleted.
	local present
	present="$(remote_names)"
	for name in "${OVERRIDES[@]}"; do
		grep -q "^$name=" "$file" && continue
		grep -qx "$name" <<<"$present" || continue
		# No --force on `secret delete`, and it prompts. CI=true makes wrangler
		# take the default on its own.
		CI=true npx wrangler secret delete "$name" >/dev/null 2>&1 &&
			echo "deleted $name — the Worker now uses the live default" ||
			echo "could not delete $name — remove it by hand: npx wrangler secret delete $name" >&2
	done

	echo
	echo "Secrets take effect immediately — no redeploy needed."
	if [ "$MODE" = test ]; then
		echo "$SITE_ORIGIN is now in TEST payment mode: cards are not charged."
		echo "Confirm with: npm run secrets:verify -- test"
		echo "Back to live: npm run secrets:push"
	else
		echo "Confirm with: npm run secrets:verify"
	fi
}

cmd_verify() {
	set_mode "${1:-}"
	local location actual
	location="$(checkout_location)"
	actual="$(classify_location "$location")"

	if [ "$actual" = none ]; then
		echo "FAIL  $SITE_ORIGIN/api/v1/checkout did not redirect" >&2
		echo "      CREEM_PRODUCT_ID is probably unset — purchases are switched off." >&2
		return 1
	fi

	echo "  checkout -> $location"
	case "$actual" in
		unknown)
			echo "WARN  unrecognised checkout host — verify by hand." >&2
			return 1
			;;
		"$MODE")
			echo "OK    $MODE checkout"
			;;
		test)
			echo "FAIL  that is Creem's test store — the buy button collects no money." >&2
			echo "      Run: $(push_hint live)" >&2
			return 1
			;;
		live)
			echo "FAIL  that is the live checkout — a test purchase there charges a real card." >&2
			echo "      Run: $(push_hint test)" >&2
			return 1
			;;
	esac
}

# `verify` asserts; this only reports. Worth having separately because the
# honest answer to "which mode is production in right now" should not require
# guessing the answer first in order to phrase the question.
cmd_mode() {
	local location actual
	location="$(checkout_location)"
	actual="$(classify_location "$location")"
	case "$actual" in
		none)
			echo "OFF   $SITE_ORIGIN/api/v1/checkout did not redirect — purchases are switched off." >&2
			return 1
			;;
		test)
			echo "TEST  $location"
			echo "      Cards are not charged. Back to live: $(push_hint live)"
			;;
		live)
			echo "LIVE  $location"
			echo "      Real cards. To test: $(push_hint test)"
			;;
		unknown)
			echo "?     unrecognised checkout host: $location" >&2
			return 1
			;;
	esac
}

case "${1:-}" in
	init) cmd_init ;;
	check) cmd_check "${2:-}" ;;
	push) cmd_push "${2:-}" ;;
	verify) cmd_verify "${2:-}" ;;
	mode) cmd_mode ;;
	*)
		echo "usage: $0 {init | check [live|test] | push [live|test] | verify [live|test] | mode}" >&2
		exit 2
		;;
esac
