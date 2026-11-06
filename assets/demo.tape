# The README's GIF: vhs assets/demo.tape, from the repo root, after npm run build.
#
# The output is a real run of the demo, measured as it's recorded. Until the package is published,
# npx can't fetch it, so a hidden function runs the local build under the same words. Record this again
# without the Hide block once crumple-mcp is on npm (Task 36).

Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 1020
Set Padding 24
Set TypingSpeed 60ms
Set Theme "Builtin Dark"

Hide
Type "npx() { node dist/cli/bin.js demo | cut -c1-118; }; PS1='$ '; clear"
Enter
Show

Sleep 500ms
Type "npx crumple-mcp demo"
Sleep 500ms
Enter
Sleep 14s
