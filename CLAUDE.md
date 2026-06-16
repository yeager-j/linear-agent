# CLAUDE.md

## Code Style

> _Perfection is lots of little things done well_
>
> — Marco Pierre White

1. **Keep it simple; don't get clever.** As the great Brian Kernighan said, _"Everyone knows that debugging is twice as hard as writing a program in the first place. So if you're as clever as you can be when you write it, how will you ever debug it?"_
2. **Give functions and files clear names and purposes.** Each function should have one job and do it well. Avoid side effects where possible. Pure, single-purpose functions are easy to test and maintain. The same principle applies to files; each file should do one thing well.
3. **Avoid inline comments.** If your code needs a comment to be understood, try refactoring it by extracting variables or creating functions. Barring some unusual techniques for performance reasons, your code should read like a sentence. Again, as the great Brian Kernighan said, _“Don’t comment bad code — rewrite it!”_ However, always write documentation (e.g. JSDocs).
4. **Resist premature abstraction.** Just because two pieces of code look similar doesn't mean they should be combined. Every abstraction introduces coupling, creating dependencies that make future changes more difficult.
5. **Favor composition over inheritance.** This creates more flexible code with fewer hidden dependencies. Inheritance expects you to bundle common behavior into a parent type, but as soon as you find an exception to the commonality, an expensive refactor is required. If you think your inheritance structure is perfect, remember that change is the enemy of perfect design.
6. **Avoid nesting the Happy Path.** If your Happy Path is nested within a bunch of conditionals, try inverting the conditions and using early return statements. If the conditionals are complex, it might be worth extracting them into their own bite-sized functions.
7. **Write tests to enable confident refactoring.** Tests aren't just about verifying code works today; they're about maintaining the freedom to improve it tomorrow. Good tests let you iterate on implementation details while ensuring behavior remains consistent, turning what would be hours of debugging into seconds of test runs.
8. **Leave the codebase better than you found it.** If you're about to reach for a type cast that papers over a real mismatch (as unknown as X), duplicate logic because the shared abstraction is awkward, suppress a lint or type error, write a TODO that hides a correctness issue, or add a special-case branch with no precedent — stop and ask. The user will tell you whether to fix the underlying issue in the current ticket or file a follow-up tech-debt ticket. This applies in auto-mode too; the bar to interrupt is higher but the bar for code quality isn't.