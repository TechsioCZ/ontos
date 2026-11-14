# The files of one weighted shard, from an `rstest list --filesOnly --json` listing (see rstest-weighted-shard.sh).
# Arguments: $weights (file-name prefix -> seconds of the family), $count, $index, $fallback (seconds per other file),
# $fresh (app-relative files that must migrate their own database), $freshMode ("skip", "only" or ""), $appRoot.
def name: split("/") | last;
def fresh: (if startswith($appRoot) then .[($appRoot | length):] else . end) as $relative
  | ($fresh | index($relative)) != null or ($relative | test("migration|stage-recovery|fresh-database"));

[(if type == "array" then . else .items end)[] | .file] | unique
| map(select(if $freshMode == "skip" then (fresh | not) elif $freshMode == "only" then fresh else true end))
| . as $files
| ($weights | to_entries | map(
    .key as $prefix
    | ([$files[] | select(name | startswith($prefix))] | length) as $members
    | {prefix: $prefix, seconds: (if $members == 0 then 0 else .value / $members end)}
  )) as $families
| [$files[] | . as $file
    | ([$families[] | select(.prefix as $prefix | $file | name | startswith($prefix))] | sort_by(.prefix | length) | last)
      as $family
    | {file: $file, weight: (if $family == null then $fallback else $family.seconds end)}]
| sort_by(-.weight, .file)
| reduce .[] as $test ({loads: [range($count) | 0], files: [range($count) | []]};
    (.loads | index(min)) as $lightest
    | .loads[$lightest] += $test.weight
    | .files[$lightest] += [$test.file])
| .files[$index - 1][]
