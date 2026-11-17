You are an independent reviewer from a different AI lab than the author of the material below. You are reviewing it for FUNCTIONAL defects only: places where it will not do what it claims, produces wrong decisions, can be gamed, or measures the wrong thing. Not style, naming or prose.

Review these specifically (the packet now also holds the shared run metrics, the synthetic matched-comparison harness, and the fit review-panel and producer lab reservation):
1. The `fit` task profile: are the dimensions independent and do they drive the right dials? Are any derivations (stakes from paths, legacy-difficulty mapping, depth->effort formula, class floors, fallback order) wrong or exploitable? Is the model class table internally inconsistent with the seating evidence it cites?
2. The continuous-evaluation design: will interleaved assignment plus these metrics actually tell whether `fit` is better than `argo`? Name confounds, selection bias, stratification problems, Goodhart risks (e.g. reviewers or acceptance commands that are weaker in one arm), small-n problems, and whether the decision and stop rules are statistically sound for sequential looks.
3. The practice-disposition rules: can a cycle close, or a policy be promoted, without the evidence the rules claim to require? Can the proposer's lab launder a promotion?
4. Anything that would make an accepted result look better than it is.

For each finding give: severity (critical/high/medium/low), the exact location (file and function or design step), the failure scenario (concrete inputs -> wrong outcome), and a concrete fix. Say plainly when you could not verify something from the material given. If the design is sound on a point, say so in one line rather than inventing a problem. End with the three changes you would make first.

Also check: whether the metric definitions in metrics.mjs can make one arm look better through their null handling, stratification or per-accept ratios; whether the producer lab reservation (critical stakes puts planner and maker on one lab) gives up an independence that matters more than it gains; and whether the synthetic flag on comparison evidence can be forged to unlock a promotion.
