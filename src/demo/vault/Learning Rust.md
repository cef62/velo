---
created: {{-45 20:00}}
modified: {{-10 21:45}}
tags: [learning, ideas]
---
# Learning Rust

Working through the book in the evenings. Goal: rewrite the Project Lantern sync core in Rust so it can run on every platform.

## Things that clicked

- Ownership is just "who frees this?" made explicit
- `Result` + `?` reads better than exceptions once you get used to it
- Iterators compile down to the same code as hand-written loops

## Things that hurt

- Lifetimes in structs
- Async: so many runtimes

- [ ] Finish chapter 16 (concurrency)
- [x] Chapter 10 exercises @done({{-10}})
