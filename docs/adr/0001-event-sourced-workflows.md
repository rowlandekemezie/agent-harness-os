# Reconstruct workflows from append-only events

Durable workflows use an append-only, digest-chained journal and derive current
state by replay instead of updating a mutable status document. This costs more
validation code and makes event compatibility permanent, but it gives crash
recovery one authoritative source, preserves every approval and retry decision,
and reuses the project's fail-closed artifact trust model. A resume marks an
unfinished stage interrupted and starts a fresh delegation; provider execution
itself is never resumed in place.
