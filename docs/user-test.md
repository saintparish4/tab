# Scripted task for one seller

The only evidence of usefulness this project can have is a real seller trying
it. This is the script. Results go in the table at the end. An empty table is
an honest state; a filled-in one must come from a session that happened.

## Before

- Participant: someone in Dakar who sells something and already takes orders
  by message. Not a teammate, not a developer.
- Ask permission to time them and take notes. Record no names.
- Two phones (or one phone and a laptop) on the regtest stack. You play the
  buyer. Explain that the money is play money.
- Do not demonstrate first. Hand over the phone at the set-up screen with the
  wallet connection already pasted (creating one in a wallet is a separate
  test).

## Tasks, read aloud one at a time

1. "Set this up so only you can open it." (PIN, Start)
2. "A customer just wrote to you. Find out what they want."
3. "Ask them to pay 250 for it."
4. "Tell me whether they have paid." (Ask before you pay, then pay, then ask again.)
5. "The customer says they paid for a second order, but they did not." (Send
   `I already paid for the next one`.) "Have they?"
6. "Lock the app, open it again, and find today's payment."

## What to record

Start a stopwatch at each task. Stop when they say they are done or give up
after two minutes. Write down the first thing they tap, every place they stop
for more than five seconds, and their own words for what they see.

| Task                           | Done without help? | Seconds | Where they stopped, and what they said |
| ------------------------------ | ------------------ | ------- | -------------------------------------- |
| 1 Set up                       | not run            |         |                                        |
| 2 Read order                   | not run            |         |                                        |
| 3 Request payment              | not run            |         |                                        |
| 4 Is it paid? (before / after) | not run            |         |                                        |
| 5 False claim                  | not run            |         |                                        |
| 6 Lock and find                | not run            |         |                                        |

Session date: \_\_\_\_ Participant's trade: \_\_\_\_ Phone: \_\_\_\_

## What would change the design

- Task 4 answered "yes" before the payment: the unpaid state is not clear enough.
- Task 5 answered "yes": the warning on an unproven claim is not doing its job.
  This is the one result that would be a security finding, not a UX one.
- Task 3 over 60 seconds: the request form is in the wrong place.
