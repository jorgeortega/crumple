# The README's GIF: vhs assets/demo.tape, from the repo root.
#
# A real run of the published package, measured as it's recorded. The hidden lines only set the prompt
# and give npm an empty cache and folder, without its update notice, so npx fetches crumple-mcp from npm as a stranger's would.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 1020
Set Padding 24
Set TypingSpeed 60ms
Set Theme "Builtin Dark"

Hide
Type `PS1='$ '; export npm_config_cache=$(mktemp -d) npm_config_update_notifier=false; cd $(mktemp -d); clear`
Enter
Show

Sleep 500ms
Type "npx crumple-mcp demo"
Sleep 500ms
Enter
# npx asks before installing, as it does for anyone running this the first time.
Wait+Screen@60s /Ok to proceed/
Sleep 1s
Type "y"
Enter
Wait+Line@60s /^\$ *$/
Sleep 4s
