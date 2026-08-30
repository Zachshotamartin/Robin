# Guard Policy Language v1

The `.guard` language is a deliberately small, deterministic authorization
language. It describes policy rules; it does not perform I/O, load code, call
providers, mutate state, or discover attributes. Parsing is separate from type
checking and evaluation. A policy file is enforceable only after all three
stages succeed and the resulting immutable snapshot is pinned to a run.

The authoritative machine-readable grammar is
[`packages/policy-language/grammar.ebnf`](../packages/policy-language/grammar.ebnf).
The reviewed built-in examples are [`policies/default.guard`](../policies/default.guard)
and [`policies/strict.guard`](../policies/strict.guard).

## Complete v1 grammar

```ebnf
document          = { policy } ;
policy            = "policy", string, "priority", integer, "{",
                    "when", expression,
                    effect,
                    "reason", string,
                    "}" ;
effect            = "allow" | "deny" | "require_approval" ;
expression        = or_expression ;
or_expression     = and_expression, { "or", and_expression } ;
and_expression    = unary_expression, { "and", unary_expression } ;
unary_expression  = [ "not" ], primary ;
primary           = "(", expression, ")"
                  | "exists", "(", attribute, ")"
                  | comparison ;
comparison        = attribute, operator, value ;
operator          = "==" | "!=" | "in" | "matches" | "starts_with" ;
attribute         = identifier, { ".", identifier } ;
value             = string | integer | boolean | list ;
list              = "[", [ value, { ",", value } ], "]" ;
boolean           = "true" | "false" ;
integer           = "0" | nonzero_digit, { digit } ;
identifier        = identifier_start, { identifier_continue } ;
identifier_start  = letter | "_" ;
identifier_continue = letter | digit | "_" ;
```

Whitespace is ASCII space, tab, LF, CR, or CRLF and may occur between tokens.
CRLF counts as one physical line break. Comments are not part of v1. Identifiers
are intentionally ASCII to make security-sensitive names visually stable.
Keywords are lowercase and case-sensitive. Integers are non-negative decimal
safe integers; leading zeroes are invalid except for the literal `0`.

Every policy has exactly one condition, one effect, and one non-optional reason.
There are no imports, user-defined functions, variables, loops, mutation,
interpolation, regular-expression literals, or network-backed attributes.

## Strings and Unicode

Strings use double quotes. The only short escapes are `\"`, `\/`, `\\`, `\n`,
`\r`, and `\t`; `\uXXXX` accepts four hexadecimal digits. A high-surrogate
escape must be followed immediately by a low-surrogate escape, and a low
surrogate cannot appear alone. Raw or escaped unpaired surrogates are errors.
Raw Unicode scalar values are retained. Raw C0 and C1 control characters are
errors; the formatter represents them with supported escapes.

The lexer scans Unicode code points while retaining three coordinates on every
token and diagnostic:

- zero-based byte offset in the UTF-8 encoding;
- one-based physical line;
- one-based Unicode-code-point column.

Span starts are inclusive and ends are exclusive. A decoded string value and
its exact raw lexeme are separate token fields.

## Expressions and binding

The parser uses these binding powers:

| Operator | Left | Right |
|---|---:|---:|
| `or` | 10 | 11 |
| `and` | 20 | 21 |
| comparisons | 30 | 31 |
| prefix `not` | 0 | 40 |

A comparison is a grammar-level primary: `not action.operation == "write"`
negates the complete comparison. Parentheses create an explicit group AST node.
`and` and `or` associate left. A second unparenthesized `not` is outside the v1
grammar.

The language parser accepts syntactically valid attribute paths without knowing
their types. The policy engine owns the closed catalog. The generic catalog is
defined by `docs/GENERAL_RUNTIME_ARCHITECTURE.md` and begins with names such as
`action.pack`, `action.operation`, `resource.classification`,
`environment.sandboxed`, and `subject.kind`. Installed capability packs add
versioned namespaces such as `repo.path`. Unknown attributes fail type checking;
syntax acceptance does not make an attribute valid.

`matches` is syntactic at this layer. The policy engine compiles its string
operand once as a bounded, anchored, case-sensitive path glob over canonical
forward-slash paths. A catalogued canonical-path target may be either `string`
or `list<string>`. A scalar target keeps the original single-path behavior. A
list target uses existential semantics: the comparison is true when any member
matches, false when no member matches (including an empty list), and unknown
when the optional attribute is absent. Every member must already be a valid
typed catalog value; a wrong runtime type fails policy evaluation closed.
Runtime regular expressions are not a v1 feature.

The `guard.repo` v3 catalog separates authorization inputs from released
outputs. `repo.path` is one optional canonical repository path.
`repo.input_paths` is sourced from normalized `resource.paths` and contains the
exact bounded canonical multi-path input set that policy must authorize before
the provider opens. `repo.paths` is sourced from broker projection
`resource.outputPaths` and contains the bounded set of canonical identifiers
actually emitted by a repository capability result. `resource.paths` and
`resource.outputPaths` are internal policy projections, not new agent-view
fields. Repository packs deduplicate and bound both sets; emitted paths are
sorted by UTF-8 bytes and bound to the exact action, raw result, and agent view.
Repeated matches in a search still contribute only one output policy path.

An exact empty `repo.path` common-root locator is absent for catalog extraction:
`exists(repo.path)` is false and `repo.path matches ...` is unknown. This narrow
rule applies only to an optional scalar canonical-path attribute. It does not
make empty string a canonical file path or change glob semantics, and wrong
runtime types still fail closed.

## Canonical form

The formatter emits:

- one space between tokens;
- two-space indentation inside a policy;
- one policy field per line;
- one blank line between policies;
- canonical decimal integers and string escapes;
- a final newline for a non-empty document.

It preserves explicit group nodes and adds parentheses when needed to preserve
an AST. Parsing canonical output and formatting it again must be byte-identical.
Parse-format-parse must preserve the structural AST after source spans are
removed.

## Diagnostics and recovery

Lexical diagnostics use `GL1xxx` codes; parser diagnostics use `GL2xxx`. Every
diagnostic includes phase, stable code, error severity, message, source ID, and
span. An invalid character always advances at least one code point. Parser
recovery synchronizes at the next policy declaration, effect, `reason`, closing
brace, or end of file, so one check reports multiple independent errors.

`parseGuardDocument` always returns a frozen result. `ok` is true only when no
lexer or parser diagnostic exists. Its recovery document contains only complete
rules. Callers must never type-check, snapshot, or enforce a result with
`ok === false`.

The default nesting bound is 128; callers may select a positive bound no larger
than 1,024. Exceeding it is a diagnostic and recovery condition, not an uncaught
recursion failure.

## Public TypeScript API

```ts
const lexed = lexGuardSource(source, { sourceId: "policies/default.guard" });
const parsed = parseGuardDocument(source, { sourceId: "policies/default.guard" });

if (!parsed.ok) {
  // Render every parsed.diagnostics entry and reject policy loading.
}

const canonical = formatGuardDocument(parsed.document);
```

All result arrays, tokens, positions, spans, AST nodes, and semantic projections
are deeply frozen. Options are captured once through own enumerable data
descriptors; accessors, proxies, symbols, inherited properties, and unknown
keys are rejected without executing caller code. The formatter normally accepts
parser-owned ASTs, and defensively verifies any public input as a finite plain
data tree before reading it. `projectGuardDocumentSemantics` removes source
coordinates for golden and structural round-trip comparisons; it is not an
evaluator.

## Reviewed examples

```guard
policy "deny-secret-repository-reads" priority 1000 {
  when action.pack == "coding.virtual-repository"
    and (repo.path matches "**/.env*" or repo.input_paths matches "**/.env*")
  deny
  reason "Secret-bearing repository paths cannot be operated on"
}
```

```guard
policy "deny-secret-repository-output-paths" priority 950 {
  when action.pack == "guard.context"
    and (repo.path matches "**/.env*" or repo.paths matches "**/.env*")
  deny
  reason "Secret-bearing repository paths cannot enter agent context"
}
```

```guard
policy "approve-dependency-installation" priority 700 {
  when action.pack == "process" and request.intent == "install_dependency"
  require_approval
  reason "Dependency installation may execute third-party lifecycle code"
}
```

```guard
policy "allow-sandboxed-tests" priority 500 {
  when action.pack == "process" and action.operation == "run_tests" and environment.sandboxed == true
  allow
  reason "Pinned test recipes may run inside the selected sandbox profile"
}
```

These are syntax and policy-review examples. Their effects become enforceable
only after closed-catalog type checking, immutable snapshot compilation, and
gateway integration. If no rule matches, the production policy engine defaults
to deny; that default is not encoded by silently adding a parser rule.
