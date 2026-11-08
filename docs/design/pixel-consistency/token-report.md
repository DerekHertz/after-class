# Interface consistency Claude tokens

Issue #133 used one local Claude implementation run with the project derek-mode instructions and installed pstack skill text. The unavailable Claude plugin adapter was replaced by supplying the installed skill text directly in the prompt.

| Run | Fresh input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Pixel interface consistency | 184,670 | 7,204,987 | 68,685 |

Fresh input is 114 input tokens plus 184,556 cache-creation tokens. Cached input counts repeated reads of cached context across the run. Output includes 34,122 thinking tokens. These are the worker's reported totals, not unique source size or parent/reviewer-agent usage. No monetary estimate is reported.
