Hand-written source maps that try to misbehave:

- `escape.js.map`: source paths that climb out of the output folder
- `broken.js.map`: mappings that point at a source the map does not list
- `truncated.js.map`: JSON cut off half way
- `dup-one.js.map` and `dup-two.js.map`: the same path with different content
- `clash.js.map`: paths that differ only in case, and a file whose path is also used as a folder
