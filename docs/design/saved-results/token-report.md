# Saved-results Claude tokens

Issue #131 used one local Claude implementation run with the project derek-mode instructions and the installed pstack skill text. The Claude plugin adapter was unavailable, so the prompt supplied the installed skill text directly.

| Run | Fresh input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Pixel saved-results | 72,511 | 1,295,160 | 15,510 |

Fresh input is 44 input tokens plus 72,467 cache-creation tokens. Cached input is the reported cache-read count across the run, so repeated context is counted each time it is read. Output includes 6,362 thinking tokens. These are the worker's reported usage totals, not unique source size or parent-agent usage. No monetary estimate is reported.
