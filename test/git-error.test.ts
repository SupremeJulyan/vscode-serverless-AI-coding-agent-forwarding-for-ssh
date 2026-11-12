import assert from 'node:assert/strict'
import test from 'node:test'
import { describeGitOperationError } from '../src/git/git-error'

test('Git credential failures explain how to configure GitHub login',()=>{
    for(const detail of ["could not read Username for 'https://github.com': terminal prompts disabled",'Authentication failed','Cannot prompt because user interactivity has been disabled','could not read Password']){
        const message=describeGitOperationError(new Error(detail))
        assert.ok(message.includes(detail))
        assert.match(message,/gh auth login/)
        assert.match(message,/gh auth setup-git/)
        assert.match(message,/WSL/)
        assert.equal(describeGitOperationError(message),message)
    }
})

test('Git network and unrelated failures retain their original messages',()=>{
    for(const detail of ['Could not resolve host: github.com','Failed to connect to github.com','non-fast-forward','Permission denied (publickey)']){
        assert.equal(describeGitOperationError(new Error(detail)),`Error: ${detail}`)
    }
})
