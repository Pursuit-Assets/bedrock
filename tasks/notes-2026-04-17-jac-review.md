# Bedrock Dev -> Main (PRs rolled into one)

**Meeting Date:** 17th Apr, 2026 - 2:00 PM

---

**JP Bowditch (theythem)** *[00:00]*: As much feedback as you want. And I will just try and plow through as much of it as I can. 
**Jacqueline Reverand** *[00:06]*: Cool. 
**JP Bowditch (theythem)** *[00:07]*: Yeah. 
**Jacqueline Reverand** *[00:07]*: Sweet. Let me share. 
**JP Bowditch (theythem)** *[00:10]*: How do you want to do this? Yeah. 
**Jacqueline Reverand** *[00:11]*: Okay. So I just kind of went through the basics. I'm thinking maybe we can just like test together quickly. Okay. So that I understand what desired behavior is. 
**JP Bowditch (theythem)** *[00:25]*: And first off, can you tell me what this is? 
**Jacqueline Reverand** *[00:27]*: This cursor? 
**JP Bowditch (theythem)** *[00:29]*: This is the new cursor. 
**Jacqueline Reverand** *[00:30]*: Yeah. It's really good. 
**JP Bowditch (theythem)** *[00:31]*: Interesting. 
**Jacqueline Reverand** *[00:32]*: I really just love how I can like have all my different repository. 
**JP Bowditch (theythem)** *[00:37]*: That's so funny. I'm like. I like, oh, you've got an ultra plan now too. I, you know, I told you I know Sasha like through my partner who's very close with his wife. So. Yeah. Because they went to college together, I was just a couple of years behind them. So I am. I like, wanna support cursor, but I'm so happy with Claude code right now. I'm just like. And I feel like I'm learning more because I have to. You like, I. I've learned just like simple commands now in. Anyway, this is. Yeah, but now. But now I'm like, oh, this looks cool. So maybe I should go back to using cursor a little bit. 
**Jacqueline Reverand** *[01:22]*: Yeah. I've just been trying not to let myself get too comfortable or narrowed into anything. 
**JP Bowditch (theythem)** *[01:29]*: That's a good idea. 
**Jacqueline Reverand** *[01:30]*: Also, Claude, I don't know, they've been having some issues lately. Like sometimes it's that down. So I just like. 
**JP Bowditch (theythem)** *[01:36]*: I mean, I still have it, so, like, I could switch to it, but yeah, I've fully switched to iTerm2. I also asked it. It is a little bit more secure to work directly in your clique. There's just like fewer. There's fewer layers for leakage. Yeah, exactly. There's like, there's more possibilities for leakage or whatever. That's probably not the right term, but I think you know what I mean. 
**Jacqueline Reverand** *[02:01]*: Yeah. I also find that cursor just like does more without asking me, which is a good and bad thing. But sometimes when I know I'm working in like a safe environment and I know it's a simple thing, I'm just like, just do it. 
**JP Bowditch (theythem)** *[02:14]*: Yeah, no, totally. Okay, cool. Let's work through it. Should I have something else up or. Or should I just pay attention and. 
**Jacqueline Reverand** *[02:26]*: Let's just start with I'll share my screen and like, kind of look at understand. 
**JP Bowditch (theythem)** *[02:31]*: But then maybe I might take notes. Do you mind if I take notes. 
**Jacqueline Reverand** *[02:35]*: By hand here as well? Whatever you prefer. 
**JP Bowditch (theythem)** *[02:38]*: I I use fireflies, but I just. I think my brain works better. You know what I mean? Yeah, it just engages a different. It is. I think it's good to take handwritten notes. It's engaging more of your brain. Yeah, they have a lot of neuroscience on this. So. Anyway, sorry, go ahead. 
**Jacqueline Reverand** *[02:59]*: But yeah, I'm thinking, like, we can do a quick run through together here and then maybe we can both just spend some time testing Fuzzing. Do you know that term? 
**JP Bowditch (theythem)** *[03:09]*: Yeah. 
**Jacqueline Reverand** *[03:11]*: Yeah. Maybe we can just do some of that and try to catch as much as we can, but. 
**JP Bowditch (theythem)** *[03:16]*: Sounds good. 
**Jacqueline Reverand** *[03:17]*: Generally, it looks like this pr, you fix a lot of the stuff from before and then you did a lot of like, stage. 
**JP Bowditch (theythem)** *[03:24]*: Yes. 
**Jacqueline Reverand** *[03:25]*: Defining. Can you talk me through the stage stuff more? 
**JP Bowditch (theythem)** *[03:30]*: It will help if we look at a specific PR. Which. So I can't remember which. PR push the stage stuff. 
**Jacqueline Reverand** *[03:42]*: 139 Maybe. But I guess I'm. I'm asking more just generally, like, what was the issue and what did you do to fix it? 
**JP Bowditch (theythem)** *[03:52]*: Yeah, so there were a lot of issues, as I said yesterday when I asked it to check. Because sometimes it's been making up our stages based off of what it assumes Salesforce should use as canonical stages. But I'm like, no, no. We have our own custom stages and those are sacred. Like, we're not planning to change our stages. We might sunset some of them. But like the core ones that I've laid out, lead gen, new lead, qualifying, design proposal, negotiation, contract creation, negotiation, contract collecting in effect. And then the other closed ones, right? Closed, did not fulfill, close, completed, closed, lost and withdrawn. I think those are all the ones that we have to have in here. And it's only like 10, maybe 11 if I can't remember exactly. 
**JP Bowditch (theythem)** *[04:48]*: But there's actually 22 stages that we've defined in our Salesforce instance, including a bunch that were relevant to philanthropy. Like closed one. Yeah, because donor box automatically applies closed one. And like, we don't need to undo the donor box. Like, we don't need to deal with that. We just can have bedrock, like properly categorize these. So a lot of, like, your work here on the progress page is so awesome. But, like, it needs to know what to count as a win. Should it count things as collecting, in effect, as a win? I said yes, because we count it as revenue booked when we move it to electing, in effect, because the contract is created, fully negotiated, and therefore should be signed. 
**JP Bowditch (theythem)** *[05:37]*: And so when I'm creating our guidebook, you know, for this, which is Part of what I'm going to be working on over the weekend, I don't have that built out fully yet. The documentation is updated, but I need to like actually do some writing there too, I think. Yeah. So I haven't done that yet, but I. But I will. So it was catching things like that. It was catching things like. And that's why I'm like not able to give you a perfect comprehensive summary of everything. But the main things we caught were that we caught. The in collection is used for about 575 or so Isa records in Salesforce. Surprisingly those. When you can see all this in the Salesforce developer console, it's awesome. 
**JP Bowditch (theythem)** *[06:25]*: Just run SQL queries real quick to like see what's in there and like how it's grouped all of those ISA. I guess their opportunities were created 2019 to 2021. It's weird. So like someone put ISAs in there for some of them, but then we must have switched at some point. 
**Jacqueline Reverand** *[06:50]*: Yeah. 
**JP Bowditch (theythem)** *[06:51]*: And I wasn't working on any of that, so. And it predates me at pursuit most of the time. So I don't really know what's going on there. But I know that around that time is when we got serious about like some of these system stuff. Like somewhat serious, you know, I know like roughly around then is when we defined stages as we now have them, basically. So I think something got kind of lost and probably there was no real effort to standardize across the different types of opportunity record types. So there's philanthropy, there's ISAs, there's, you know, PBC contracts. Right. 
**Jacqueline Reverand** *[07:31]*: Yeah. 
**JP Bowditch (theythem)** *[07:32]*: And I think eventually we should standardize those like were talking about yesterday. 
**Jacqueline Reverand** *[07:36]*: Right. 
**JP Bowditch (theythem)** *[07:38]*: And so this was an attempt not to standardize, but to just make sure that all these like, you know, buckets of stages count the right things. 
**Jacqueline Reverand** *[07:48]*: Right. 
**JP Bowditch (theythem)** *[07:48]*: So that's really. That's really what it was focused on. 
**Jacqueline Reverand** *[07:51]*: Okay. 
**JP Bowditch (theythem)** *[07:52]*: Because otherwise we could double. We were double counting the donor box. 
**Jacqueline Reverand** *[07:56]*: Got it. So this whole thing is not filtered on opportunity type, right? 
**JP Bowditch (theythem)** *[08:04]*: Correct. 
**Jacqueline Reverand** *[08:04]*: It is. 
**JP Bowditch (theythem)** *[08:05]*: I am working. That is the. Actually one of the. So I have like a ton of stuff in plans for dev that I need to get out onto dev and then we can work on that. But this is what I've. I'm like right now targeting MVP stuff. Okay. That record type isn't relevant yet. It's like we're just launching this as philanthropy mvp. So it works for philanthropy or. Well, I need to check some things like the donor box issue is that. Did we actually resolve that or does it just think we resolved it. So I need to do. That's some of the, I guess fuzzing but like. 
**Jacqueline Reverand** *[08:47]*: So PBC is included in all this, right? So like Devica's recent like PVC win should be in here or is it. 
**JP Bowditch (theythem)** *[08:57]*: Yes, that's right. Yeah. No, because Merkur Cash for Data, right. Is a PVC contract, right? 
**Jacqueline Reverand** *[09:04]*: Yeah, yeah, yeah. 
**JP Bowditch (theythem)** *[09:05]*: Why don't we just spot check one in the search? You can just search for it. 
**Jacqueline Reverand** *[09:10]*: Yeah. 
**JP Bowditch (theythem)** *[09:11]*: Oh, no, it wouldn't. No, that's. That's actually not going to work because it'll bring up anything. But I guess we could find out what kind it is. 
**Jacqueline Reverand** *[09:20]*: Yeah, I'll just bring it up. 
**JP Bowditch (theythem)** *[09:21]*: It should be under type. Oh, it doesn't have a type. Look, it's right up there. But it doesn't have a type. 
**Jacqueline Reverand** *[09:28]*: That's weird. 
**JP Bowditch (theythem)** *[09:30]*: Yeah, I thought so. 
**Jacqueline Reverand** *[09:35]*: Let me just look in my browser. 
**JP Bowditch (theythem)** *[09:37]*: Yeah,. 
**Jacqueline Reverand** *[09:49]*: It's other fee for service. 
**JP Bowditch (theythem)** *[09:52]*: Yes. So that is a PBC contract. 
**Jacqueline Reverand** *[09:54]*: Okay. 
**JP Bowditch (theythem)** *[09:55]*: Yeah, it's just not like an employer. It's not a jobs one, basically. Yes, that's a pvc. So it is bringing in PVC right now. But that is concerning to me. So let me make a note of that. That type is not pulling in correctly. 
**Jacqueline Reverand** *[10:12]*: Yeah. I can also just note everything here. 
**JP Bowditch (theythem)** *[10:16]*: You can do that too. I'm just make. I like to. Yeah. So I need to see what's. Some of the stuff could honestly Jack still be unwired. It is very possible that like it was like, great, I built this di. This editor dialog for you and then it didn't actually wire it up. It like built the plan for it and then it didn't actually do it. So for example, like, I don't think we should only use this right sidebar for every edit because then if you wanted to click through to a contact from here, you have to close the opportunity edit that you were just working on. You shouldn't have to do that. So it's better to have them be dialogues that pop up on. 
**JP Bowditch (theythem)** *[11:02]*: On top of each other and just can stack not to infinity, but like you can stack up to 10, which is more than enough. And so that way you could go through a full workflow of like, oh, I need to update this. Oh, that contact needs updating too. Oh, it's on the wrong account. Let me update that too. And then you just go back and everything is where you left it, you know, so that's. I had thought Claude and I thought that was going to be important because Otherwise this side drawer will close. 
**Jacqueline Reverand** *[11:36]*: Stacking is tough, but like, yeah, it should be. We should be able to navigate across all the different things you might need to edit within either the side panel or the one pop up modal without losing. 
**JP Bowditch (theythem)** *[11:51]*: But do you see what. Yeah, we can switch to either one. But my point is they will have to stack. That's what people expect from Stack Windows. 
**Jacqueline Reverand** *[12:01]*: Like it can just all be the same. Like you could be able to edit that information within here, you know, like in a different tab or you know, there's. 
**JP Bowditch (theythem)** *[12:11]*: I think, I think there was a reason. Yeah, I, I personally didn't like that because it. There's. They're not. There are objects that are related to each other. They're not all living on the opportunity. So when you click in to edit the opportunity, it would then have to decide like some kind of hierarchy that doesn't actually exist between the objects. 
**Jacqueline Reverand** *[12:35]*: Yeah, honestly, this is like a UX UI best practice question that we should just leave to like, you know, the Internet and like Yoshi and Dave because. 
**JP Bowditch (theythem)** *[12:48]*: Well, but that's what I'm telling you is like I went back through it with Claude and went back and forth and it was like this is going to be most like what people expect, how people expect it to work basically, if they've used Salesforce before. So we could change that. But it involved. It would involve us coming up with a new like system for it, which could better. But I had thought of. Yeah, what if. Because we had originally just had this side drawer or a different. It was a different side drawer but like this one's better anyway. But this actually now looks like a combination of my modal or what dialog. I can't remember which it is. But the pop up. This looks more like the pop up but it switched to the column or the drawer which is fine. 
**JP Bowditch (theythem)** *[13:32]*: But now I don't like. Do you want multiple drawers opened or do you want to create a hierarchy between objects? I would highly recommend we not create a hierarchy between the objects. 
**Jacqueline Reverand** *[13:42]*: What do you mean by hierarchy? I don't think there should be multiple drawers or multiple popups. Just like. As opposed to. 
**JP Bowditch (theythem)** *[13:49]*: Well, there's. There's potentially a ton of related objects to an opportunity. Could be a dozen payments, could be a. Could be a whole bunch of contacts, could be projects and tasks related to it. So you need to have all those tabs there and like it would need to know like, I don't know, it could. It would maybe work on Opportunities. But I'm not sure how it would work on a contact or an account where, like, I don't know. I can. I can think through that. But for now, I felt like for mvp, the simplest thing was just stack them because that's how people will be used to using it in Salesforce. 
**Jacqueline Reverand** *[14:29]*: I feel like the behavior in Salesforce is open a new tab, though. 
**JP Bowditch (theythem)** *[14:35]*: That's what I always do when you're editing. It opens up when I'm editing and I click through to the primary contact on the opportunity because I want to edit that too. It opens up a pop up on top of it. But then all the information I added into the opportunity that I was creating is still waiting for me once I finish and save the contact. So it's about not losing work in progress. 
**Jacqueline Reverand** *[15:00]*: You know, I'm just gonna share my whole screen. Okay. So that you can see. But, like, are you talking about, you know, this. I'm on an opportunity. I want to edit this town. It just moves me there. 
**JP Bowditch (theythem)** *[15:16]*: No, that's not what I'm talking about. So click. Go back to the opportunity and. And start to edit a field. 
**Jacqueline Reverand** *[15:23]*: Yeah. 
**JP Bowditch (theythem)** *[15:30]*: Wait, this doesn't. What is the workflow that creates the modal then? Oh, it's when you create a new opportunity. Sorry. Or like, you can see. 
**Jacqueline Reverand** *[15:40]*: Create a new contact. 
**JP Bowditch (theythem)** *[15:42]*: Yes. Thank you. Yeah. If you create a new contact, it opens the modal. 
**Jacqueline Reverand** *[15:46]*: Yeah. 
**JP Bowditch (theythem)** *[15:48]*: Go ahead and do it. Just so we see it. You. You click next. General contact. 
**Jacqueline Reverand** *[15:52]*: Yeah. 
**JP Bowditch (theythem)** *[15:52]*: Now. Now see, if you have to create an account as well, you go in and click create an account. It just opens the modal on top so you don't lose the work you've already been doing. 
**Jacqueline Reverand** *[16:05]*: Yeah. 
**JP Bowditch (theythem)** *[16:05]*: And then if you cancel that out, the old one with everything you entered is right where you left it. I think this is just what people are going to be used to from Salesforce. So I'm not against building something better. It just feels like the thing that will make people mo. Like feel like, oh, this really can replace Salesforce. I thought that was kind of like our goal for the MVP is just get people trusting that, like everything you can do in Salesforce, more or less, you can do in Bedrock. 
**Jacqueline Reverand** *[16:38]*: Yeah. I guess I'm. I go back and forth on that because, like, on the one hand, the whole reason that we're doing this is because nobody likes using Salesforce, so that's true. I would like just caution against, especially working when you're working with an agent telling them to do it like Salesforce. It's so easy for Them to do that? 
**JP Bowditch (theythem)** *[16:58]*: No, no, we, you know, I, we built it as a drawer first and then it recommended. It was like you're going to lose. If we do drawers, it will close the drawer. So we have to come up with a. You're right, it could be tabs, but when you tab away, it has to save everything on the previous tab. And I think for some reason. 
**Jacqueline Reverand** *[17:18]*: Okay, keep going. 
**JP Bowditch (theythem)** *[17:21]*: I can't remember why. This is a long time ago when I built those dialogues, this is like two weeks ago. So if you have an example you want to show me, go for it. But the key thing is just people need to be able to start editing an opportunity, be halfway through editing it and realize they need to create a new contact. Go do that and not lose anything, you know? 
**Jacqueline Reverand** *[17:45]*: Yeah. 
**JP Bowditch (theythem)** *[17:47]*: So I guess the question maybe is, Jack, do you want me to spend a good bit of time over the weekend, like coming up with a new UI and UX there or should we ship? Like, if you think that's really important, I can prioritize that. But honestly, I think there's so many other things I'd rather get polished on here. Yeah, I agree. 
**Jacqueline Reverand** *[18:08]*: This is not those. Even those edit. 
**JP Bowditch (theythem)** *[18:10]*: Those edit things are going to be fine. Like the. We can change that later. 
**Jacqueline Reverand** *[18:15]*: Yeah, totally. 
**JP Bowditch (theythem)** *[18:16]*: Okay. 
**Jacqueline Reverand** *[18:17]*: Yeah. 
**JP Bowditch (theythem)** *[18:17]*: Okay. Because like, for example, I want to bring back the cash flow projection based off of payment schedule down below here and I need another view in here that. Because Nick is going to want to see, I think it, I think he's going to want to see here some different ways of cutting up the data. Even though it's possible to do that in other places. I think he's just going to want to have one view mainly. 
**Jacqueline Reverand** *[18:46]*: Okay. But back to the stage. So what you did was update some calculations to make sure they're right, make sure the right stuff's showing. But you're not filtering anything out in terms of like, oh, we never show this stage. And you're not grouping stages or changing stages on this front end. Right. 
**JP Bowditch (theythem)** *[19:10]*: Nothing gets changed. They just get. They, they do get rolled up into like the win line. But that's just a calculation. 
**Jacqueline Reverand** *[19:20]*: But it's not like rolling up into like collecting an effect, right? 
**JP Bowditch (theythem)** *[19:24]*: No, no. 
**Jacqueline Reverand** *[19:24]*: Okay. 
**JP Bowditch (theythem)** *[19:25]*: No, no. It's not changing any of. It's not changing anything in Bedrock unless you write it over the data, you know. 
**Jacqueline Reverand** *[19:34]*: Perfect. Yeah. 
**JP Bowditch (theythem)** *[19:35]*: Yeah, great. 
**Jacqueline Reverand** *[19:36]*: Okay. 
**JP Bowditch (theythem)** *[19:40]*: No, I haven't changed any stages. It's just definition and clarifying. Because then as were working through it, Claude was like, oh, well, we're not doing these calculations correctly then. 
**Jacqueline Reverand** *[19:54]*: Yeah. 
**JP Bowditch (theythem)** *[19:55]*: Because weren't including collecting an effect in wins and. 
**Jacqueline Reverand** *[19:59]*: Yeah. 
**JP Bowditch (theythem)** *[20:00]*: Cool. Yeah. 
**Jacqueline Reverand** *[20:03]*: So that all makes sense. 
**JP Bowditch (theythem)** *[20:05]*: I actually almost do. Do you mind? Actually, can you go back to progress? It's a little thing. What do you think about calling wins closed? I think closed one, but closed one is a specific meaning that we've already been paid. Every closed one and closed completed should mean the same thing. We've been fully paid. I think that's the last step. 
**Jacqueline Reverand** *[20:30]*: I don't think it should just be close because I actually think a really important part of managing a pipeline is to surface losses and withdraws and like. 
**JP Bowditch (theythem)** *[20:40]*: Yeah. 
**Jacqueline Reverand** *[20:41]*: So like those should even maybe be in here, if not in your own section. 
**JP Bowditch (theythem)** *[20:45]*: No, you're right. That's a. That's another. Sorry. I am writing stuff down mostly because it's like you're going to be a lot of thoughts in the transcript here. But like, the really important ones I want to immediately work on, like type is not pulling into opportunity. I need to fix that. And then that's. Yes, totally lost. Withdrawn. 
**Jacqueline Reverand** *[21:08]*: Because we actually want to encourage people to mark something as a loss when it's a loss and not just like, why don't. 
**JP Bowditch (theythem)** *[21:13]*: Why don't we just show the full pipeline? 
**Jacqueline Reverand** *[21:16]*: Yeah, yeah. 
**JP Bowditch (theythem)** *[21:17]*: All the. All the active stages for philanthropy pipeline can be here. 
**Jacqueline Reverand** *[21:21]*: Yeah. 
**JP Bowditch (theythem)** *[21:24]*: Even though this was mainly meant to be more about like getting things to the. To the win point, which is collecting an effect. Right. And so it's like the health of the pipeline after that is more of a cash flow thing. Right. It's like, how well are we managing collections, basically? Which is valuable to know. Right. But I do think you're right. It will show like how we're doing in terms of withdrawing and losing stuff too. So lost. I'll just do save full. Full pipeline. That'll be easy. Okay. What else? 
**Jacqueline Reverand** *[22:02]*: I think I noted this in the comment last time, but I can't. I still can't like edit these. 
**JP Bowditch (theythem)** *[22:10]*: Really. Okay. 
**Jacqueline Reverand** *[22:12]*: It's just the amount and the probability. Like I can't even unlock it. I think these. I unlock it and then I can do it. 
**JP Bowditch (theythem)** *[22:23]*: Got it. Okay. Actually didn't even realize that was inline editable. Yes, it's fine. 
**Jacqueline Reverand** *[22:36]*: Yeah. I think I did this. Well, I made this in line editable. But same issue here is the. 
**JP Bowditch (theythem)** *[22:43]*: Are the titles also in line? 
**Jacqueline Reverand** *[22:44]*: It. 
**JP Bowditch (theythem)** *[22:45]*: Okay, so the calculated fields are not. This is the same issue in Salesforce. So let me see. Can you go back? Which ones are they? 
**Jacqueline Reverand** *[22:53]*: Oh, this is Weird. 
**JP Bowditch (theythem)** *[22:58]*: Wait, what did you just click on? 
**Jacqueline Reverand** *[23:01]*: Trying to edit the account and it like popped up over there. 
**JP Bowditch (theythem)** *[23:07]*: So let me endline editing not working for probability. And what was it? Amount. 
**Jacqueline Reverand** *[23:20]*: Yeah. 
**JP Bowditch (theythem)** *[23:21]*: And potentially other fields. 
**Jacqueline Reverand** *[23:25]*: Yeah. 
**JP Bowditch (theythem)** *[23:27]*: And then. Oh, that's so weird. The drop down. Why is the drop down up there? I wonder if it's because you're. You're viewing this in cursor. 
**Jacqueline Reverand** *[23:39]*: Yeah, but I've actually seen this in browser too. I think it's the same. Okay. 
**JP Bowditch (theythem)** *[23:42]*: Okay. 
**Jacqueline Reverand** *[23:43]*: All right. 
**JP Bowditch (theythem)** *[23:45]*: Drop down picker or what was it? Owner. Oh, no. Account. 
**Jacqueline Reverand** *[23:55]*: Any of the drop down. Yeah. 
**JP Bowditch (theythem)** *[23:57]*: Okay. For account owner, etc. The list appears not in line. That's probably just a weird little bug that I don't think that'll be hard to fix. What else you got? 
**Jacqueline Reverand** *[24:24]*: Just overall, I don't know if these all need like a warning box, but maybe we start with that. I just don't want people to like, I want people to think, oh wow, this is so much easier than Salesforce. 
**JP Bowditch (theythem)** *[24:38]*: Totally. Yeah. I think I was make. I wanted to make inline editing. Like I've accidentally changed things a lot using the inline editing and I guess I wanted to make it a little bit harder to do that. 
**Jacqueline Reverand** *[24:52]*: Yeah. 
**JP Bowditch (theythem)** *[24:53]*: But let me. How would I say revisit softening inline edit locks? 
**Jacqueline Reverand** *[25:06]*: Or if you do want a warning, maybe it's that you do it and then it pops up and says confirm you're changing this. You know, so I could click this, click JP and then it would say like confirm. Or maybe it confirms at the end of like, maybe you can edit the whole line at once and then it confirms, I don't know,. 
**JP Bowditch (theythem)** *[25:32]*: Change to a confirmation of your saves. Yeah, it's going to be tough if you're like jumping around and saving a lot. But like for example, try and edit the opportunity name. 
**Jacqueline Reverand** *[25:47]*: Yeah, like this one I can do, but it's buggy. 
**JP Bowditch (theythem)** *[25:51]*: It's actually something I've tried to fix. It's like you click into it and it's not super clear that you're editing it right away. I tried to make the like, it highlights it but it doesn't do it right away. So I need to try and fix that. But it actually is working better. Before it deleted the whole thing and just showed it blank. And I was like, no, no, that's not going to be good. So now can you try it again and just see if you're able to just change like one line on it. Okay, great. Or I. Oh, it is actually saving. You need to put the M back. 
**Jacqueline Reverand** *[26:25]*: I know, I know. 
**JP Bowditch (theythem)** *[26:27]*: Okay. 
**Jacqueline Reverand** *[26:27]*: But I mean, while we're here, let's. 
**JP Bowditch (theythem)** *[26:29]*: Just check if it actually worked. 
**Jacqueline Reverand** *[26:40]*: Yes. 
**JP Bowditch (theythem)** *[26:41]*: Yep. Wow. And it's pretty much immediate too. That's good. I was wondering if there would be like a little delay, but it sounds. If it looks like it confirms that it's actually saved as it's supposed to. Okay. So when the green check, it's like that means it landed in Salesforce. 
**Jacqueline Reverand** *[26:59]*: Yeah. 
**JP Bowditch (theythem)** *[27:00]*: Cool. 
**Jacqueline Reverand** *[27:01]*: Yeah, I guess my gut says that if we just make this a better inline editing experience and like a little faster, less glitchy, then we won't need as many cautions because it'll be like very clear when you're editing something. 
**JP Bowditch (theythem)** *[27:16]*: So more clear. Like maybe fully highlight in blue the entire field when you're editing it. 
**Jacqueline Reverand** *[27:22]*: Yeah, yeah, something. 
**JP Bowditch (theythem)** *[27:24]*: Because I just have the border around it. But it doesn't always show up really clearly when you're actually editing. Like if you click on the opportunity name again. 
**Jacqueline Reverand** *[27:33]*: Yeah, yeah. 
**JP Bowditch (theythem)** *[27:38]*: Those ones are harder to get wrong because you have to choose from the pick down your picker. Right. Like it's. It's very easy to be clicking around. I've done it a bunch of times and just turned off saving from my local environment right now to be honest, because I don't need it. 
**Jacqueline Reverand** *[27:58]*: Right. 
**JP Bowditch (theythem)** *[28:00]*: More clearer, like highlighting and maybe just research. 
**Jacqueline Reverand** *[28:09]*: Like what are the best inline editing practices components and yeah. Table structures for this. Because I do think this is like, this is the core feature is. 
**JP Bowditch (theythem)** *[28:23]*: I think it's one of them. But I actually think this is, no offense, probably going to become less and less relevant. 
**Jacqueline Reverand** *[28:29]*: Yeah. 
**JP Bowditch (theythem)** *[28:30]*: But I'm hoping that eventually pebble, you can just. Totally, totally. But I like my vision for a month from now is any edits you want to your opportunities or anything. You just talk to pebble about it and then pebble confirms for you. You get a little like you get a little table. No, you're right. You're right. No, totally. I just. Anyway, yeah, I will work on this. Yes, I agree. I will work on. 
**Jacqueline Reverand** *[28:58]*: Okay, check what else I need to test. Did you change? Oh, this is the same. This works. 
**JP Bowditch (theythem)** *[29:22]*: You just don't have any tasks. 
**Jacqueline Reverand** *[29:24]*: Yeah, this is just anyone with tasks that makes sense. 
**JP Bowditch (theythem)** *[29:26]*: You can choose anyone you want or all users if you want. 
**Jacqueline Reverand** *[29:30]*: Yeah. Yeah. 
**JP Bowditch (theythem)** *[29:36]*: Can you try and edit a task and change? Like go to the one up top that just looks like a bug or one that Erica put in and didn't really. Actually, no, it probably does have something in there. Why don't you try and create a new task or edit that one. 
**Jacqueline Reverand** *[29:52]*: Sure. 
**JP Bowditch (theythem)** *[30:00]*: Yeah. 
**Jacqueline Reverand** *[30:11]*: I think that the experience would better if you like did all of it and then it saved either here or in a sidebar. 
**JP Bowditch (theythem)** *[30:20]*: So for inline it, I, I'll check with that. It really wanted to save it so that it moves it up into the. But I, I, I'll check on that can. Because I think the idea is like someone might want to create a task just as a placeholder and then keep working. But can we make it so you would want. You can't save the task until you fill out more of it. 
**Jacqueline Reverand** *[30:54]*: Just like intuitively when I click this and put like test one, I guess like it either just needs to load faster or like I feel like I should just be able to keep going across. 
**JP Bowditch (theythem)** *[31:07]*: Okay, can we make it load faster for task saving? 
**Jacqueline Reverand** *[31:13]*: But more importantly, it's not letting me save a description. 
**JP Bowditch (theythem)** *[31:22]*: Okay, let me build. Okay. Request failed. Oh, it's probably because you don't own that opportunity. Maybe not. Let me look into that. Request failed with a 400 error when editing. When editing description, Try to add it there and change the description. 
**Jacqueline Reverand** *[32:15]*: Did I name it True? No, I thought I didn't test. 
**JP Bowditch (theythem)** *[32:20]*: You did test. That's weird. Test renamed itself to true. Yeah, it did. You have an upcoming test True. That's so weird. 
**Jacqueline Reverand** *[32:39]*: Let me just try that again. Yeah, like, it just seems like the names aren't working. 
**JP Bowditch (theythem)** *[32:54]*: Okay. So the issue actually I'm seeing here is that it's creating the task not on the opportunity, it's assigning it to. So you didn't assign it to anything? 
**Jacqueline Reverand** *[33:05]*: I didn't assign it, but it is on the opportunity. 
**JP Bowditch (theythem)** *[33:09]*: But it's not so weird. Why did it not save the title? 
**Jacqueline Reverand** *[33:13]*: Not saving the title. 
**JP Bowditch (theythem)** *[33:23]*: On save of task. Okay, I'll look into that. Check. 
**Jacqueline Reverand** *[33:50]*: No, I just deleted these. They're still here. 
**JP Bowditch (theythem)** *[33:54]*: Yeah, there isn't a. There isn't a fast. No, but that's fast. Refresh on priorities Page rarity ops. So tasks are accurate immediately. Yep. Okay. You wanted to rename this to tables or something like that. 
**Jacqueline Reverand** *[34:29]*: That's not important. Maybe we can run it by someone else. See, this is still, it's still not loading everything. Like it's only loading these top 500 because opportunities. Yeah. And you sort by amount. It'll actually. This is actually the highest amount opportunity that we have. Right? 
**JP Bowditch (theythem)** *[34:56]*: Yep. It's just on. It's just floating only 500 for some reason. 
**Jacqueline Reverand** *[35:01]*: Okay. 
**JP Bowditch (theythem)** *[35:02]*: That was probably just a bug. Yeah. 
**Jacqueline Reverand** *[35:04]*: Yeah, I had put that in the last one, but I think it's for. It's for contacts too. So just make sure that they're working the same as this one. Yeah. 
**JP Bowditch (theythem)** *[35:13]*: Can you go to contacts? Honestly, I. Jack, I may just not have gotten to shipping that one yet. I like, have gotten distracted by like so many different things that I'm like. So I may just not have gotten to that yet. I have to check like my Sprint list. 
**Jacqueline Reverand** *[35:30]*: Yeah, that's okay. 
**JP Bowditch (theythem)** *[35:32]*: But no, this is an important one, so reports. Yeah. 
**Jacqueline Reverand** *[35:38]*: Okay. Okay. Maybe it seems like we need to do a lot more testing, honestly, so maybe we should just do that in parallel. Although I don't want to be like discovering the same things and doing duplicate work. 
**JP Bowditch (theythem)** *[35:57]*: Yeah, but like, why don't you just. 
**Jacqueline Reverand** *[36:01]*: Let me thorough test of every click and also especially a full workflow in Salesforce of Create an opportunity, create a contact, create a task, create an account, progress it all, change it all. Like that entire thing and make sure it all works. 
**JP Bowditch (theythem)** *[36:17]*: Yeah. Yep. I haven't done any of that yet. Like, okay. I. Yeah, I've just been building as fast as I can to get it done. 
**Jacqueline Reverand** *[36:26]*: Yeah. Yeah. I would focus. I think, like, this is good. I think we should focus on the testing and fixing, like, essential things. 
**JP Bowditch (theythem)** *[36:35]*: No, I know. That's what I'm saying. I have a list of like some of this stuff. I. I've already note, like, I. That's why I'm like, that's just a bug. I thought I had squashed that 500 only thing. 
**Jacqueline Reverand** *[36:45]*: Yeah. So I guess how do you want me to help? Do you want me to keep testing? Do you want to. 
**JP Bowditch (theythem)** *[36:52]*: I think. I think let's. I think I should just keep working on it, to be honest. You've given me a lot of good feedback already and I don't want to. Like, you have so many other things to work on and I have. I have a lot of this already saved locally as in my Sprint plan. So do you want to not merge 139? Do you want me to just keep working in dev? What do you want? 
**Jacqueline Reverand** *[37:17]*: I'm happy to merge it. It doesn't matter. 
**JP Bowditch (theythem)** *[37:20]*: Let's merge it to main. Because I like, I just think it's. It helps mentally to be like, okay, great, I'm starting fresh on 140. You know what I mean? In dev. Like, and 139 was our. So just mentally it helps me to be like. I have in mind the last reference. Like, for example, it missed that there were some things in 102 on Main that we had been working on in dev because it's not checking main all the time, you know. 
**Jacqueline Reverand** *[37:48]*: Yeah. 
**JP Bowditch (theythem)** *[37:48]*: I have to force it to read everything every time with like four verification passes. So, you know, that just started to scare me and I'm kind of like, let's. I would like to, if you're comfortable with it, to merge this all into main. It is still buggy. This is not the MVP we're going to roll out. Probably the MVP we roll out is like 188, you know, and I'll have that ready for you to review Monday. 
**Jacqueline Reverand** *[38:18]*: Okay, cool. Fine with me. I'm happy to merge it. I think that though, like there comes a time in testing where you have to just like go human mode and like work one by one and be like, we need to fix this one thing. Do it. You know, like it's. 
**JP Bowditch (theythem)** *[38:38]*: No, I, I agree but I, I like to just. Yeah, I, I'm still, I guess figuring out like my. That's what I was doing before and I would polish up one thing. But then like we completely changed the thing that I polished so it doesn't feel worth it in a way because like it feels better to build quickly. Check with you. Are we on track? You know what I mean? Like I polished the homepage a ton to make every. And some of it is kept right on the priorities page now, but some of it is and it's like that was way like, well, it wasn't wasted work, but you know what I mean? So I hear you and I want to. 
**JP Bowditch (theythem)** *[39:19]*: I think there's like maybe 30 more bugs or so to squash and this testing review just now gave me enough to work on for at least the rest of the day. And then I kind of like, I think I need to get into a like, how do you do it? Do you like test at the. Do you like put set aside time at the end of every day to test or are you testing each and everything as you go? 
**Jacqueline Reverand** *[39:44]*: I, I guess I build pretty loosely and then at the end I'm trying to get better about this. But yeah, like I do a thorough. Well, you should have it do its own thorough review with something like playwright where it's going in and doing a click through test. 
**JP Bowditch (theythem)** *[40:03]*: I do it, I make it run more problems. 
**Jacqueline Reverand** *[40:06]*: But then I literally go through every page and say, let's work on this tiny thing. Let's work on this tiny thing and just make sure that it all is to my standards. Like kind of like putting yourself in the CEO shoes and just like, no,. 
**JP Bowditch (theythem)** *[40:22]*: I Like doing that. Yeah, I like doing that. I'm just, my feeling is that I'm not quite there yet. We've like identified enough issues that I, that are priorities to fix. I should fix those and then go back to testing as a user. So this is what I was thinking. I wanted to get into the habit of, is like build till 4 and then 4 to 6 is test time. And I don't fix any of that stuff right away. I just calm, I just create a comment or write down, you know, as I'm going. Honestly, sometimes I just like writing as I'm testing rather than like switching to a different panel and like writing the comments in my computer. Like, it just mentally works better for me. 
**Jacqueline Reverand** *[41:05]*: Yeah. And this is fine. I mean, we're just learning how to do all of this. But like, I think each PR should have a test phase built into it. You know, like every time you're working on a feature, you should make sure that you really like it before you like, try to push it. I mean, it doesn't matter for us too. But just like best practice wise so that if it touches, whoever can just merge it. 
**JP Bowditch (theythem)** *[41:37]*: If it touches a feature. I do that. But sometimes it's like a PR is just doc, mint, doc cleanup. Like, do you test that? 
**Jacqueline Reverand** *[41:48]*: No, I mean, that's fine. 
**JP Bowditch (theythem)** *[41:49]*: I sometimes just spot check the main doc that I want to make sure got updated to make. But like, most of the time, to be honest, I just trust it because I force it to do like five or six verification passes. I force it to do tests. It's test suite and passes until it's all green. 
**Jacqueline Reverand** *[42:07]*: Yeah. 
**JP Bowditch (theythem)** *[42:08]*: But it doesn't, it's not perfect. 
**Jacqueline Reverand** *[42:09]*: Every PR should have like a very, you should understand, like, this is what I was doing here. This is the, was the issue that I solved. And I have looked at it and it is now great. 
**JP Bowditch (theythem)** *[42:20]*: Okay. Yeah, makes sense. 
**Jacqueline Reverand** *[42:22]*: And, or sometimes it's just documents and whatever and that's fine. 
**JP Bowditch (theythem)** *[42:28]*: But yeah, no, I haven't gotten into the habit of that. And that feels kind of slow to me, to be honest. But maybe I need to slow down. 
**Jacqueline Reverand** *[42:35]*: But like, what a PR is, it is saying, hey, I'm done with my work. Put it up. 
**JP Bowditch (theythem)** *[42:42]*: No, I understand. Someone's, you know, someone's supposed to look at it and. No, I, I, I get it. 
**Jacqueline Reverand** *[42:47]*: Yeah, I get it. 
**JP Bowditch (theythem)** *[42:48]*: Yeah. And I, it's also just, I also kind of think of it as just the way to definitely save work. 
**Jacqueline Reverand** *[42:53]*: Yeah. 
**JP Bowditch (theythem)** *[42:54]*: You know what I mean? It's the way to save and document it so that I actually know what we did. 
**Jacqueline Reverand** *[42:59]*: I feel like. 
**JP Bowditch (theythem)** *[43:00]*: And then. Yes. 
**Jacqueline Reverand** *[43:01]*: Commits, maybe. 
**JP Bowditch (theythem)** *[43:06]*: Maybe. I don't know. 
**Jacqueline Reverand** *[43:08]*: I don't really. 
**JP Bowditch (theythem)** *[43:09]*: But then at least it's committed and not only locally committed or. No, you can push the. Commit. You can push the commits too. 
**Jacqueline Reverand** *[43:15]*: Yeah. 
**JP Bowditch (theythem)** *[43:16]*: Commit and push. Yeah, yeah, yeah. Commit and push. That's right. Okay. 
**Jacqueline Reverand** *[43:22]*: So anyway, I think this is really getting there. And yeah, I'm sorry if I like, undid any of your work here. I was kind of just playing around. But, you know, if you. 
**JP Bowditch (theythem)** *[43:32]*: No, I don't think you did. Oh, oh, wait. Yeah, you maybe did. 
**Jacqueline Reverand** *[43:38]*: I didn't do anything since last time. But you were just saying that like you lost work on the homepage or whatever. 
**JP Bowditch (theythem)** *[43:47]*: Oh, well, wait, why does it only show Devica and Guillerme? It should show everyone that has a target. 
**Jacqueline Reverand** *[43:58]*: I think maybe they. They're just the only people that have targets. Yeah. 
**JP Bowditch (theythem)** *[44:01]*: No, no, no. Okay, so you're running a different version of this right now. Shit. 
**Jacqueline Reverand** *[44:09]*: Are you sure? 
**JP Bowditch (theythem)** *[44:11]*: Yeah. Let me share my screen on the right pr. Let me share my screen. I may have rolled it up wrong, I don't know, but this is how it should look. 
**Jacqueline Reverand** *[44:29]*: Can you go to the target page? 
**JP Bowditch (theythem)** *[44:34]*: Yeah. I said all these, so. 
**Jacqueline Reverand** *[44:42]*: Well, are you working in like a local database? That's probably why. 
**JP Bowditch (theythem)** *[44:47]*: Yeah. But these should have been saved, so let me make sure that they. I guess these didn't save. Let me add that to my list. Settings, targets. Did you just set DEA and G yourself? 
**Jacqueline Reverand** *[45:05]*: Yeah, I did that. Okay. 
**JP Bowditch (theythem)** *[45:07]*: For testing targets. Not being pushed. Okay. That's probably just a little bug. Shouldn't be hard to fix. And it honestly will be resolved by not doing this in dev, to be honest. Right. Yeah. 
**Jacqueline Reverand** *[45:25]*: Yeah. 
**JP Bowditch (theythem)** *[45:26]*: That's kind of part of why I'm also like, let's merge. And then you can, like test in main too, in a way so you could actually test the user experience for real. That that was my thinking, is that it would better for me to like, do testing for real rather than. There's potentially. That is working locally, but isn't gonna. Like. This is a good example of that, but it should like, we like. I wouldn't catch this testing locally. I wouldn't have caught that. Yeah, because it's working for me, but it won't work for you. 
**Jacqueline Reverand** *[46:02]*: Well, you should make sure that even locally, you're pulling from the real database. 
**JP Bowditch (theythem)** *[46:09]*: I get that, but it's a lot to check every time, Jack. You know what I mean? It's a lot to Ask it to check like every single time. Like is. Is. Is every like. And I'm trying to every single prompt. I'm like, double check your work. Double check your work. So. But these kinds of things, like, it's. 
**Jacqueline Reverand** *[46:25]*: Easy to see on the front end. Like, I'm local now, but I'm connected to the real database. So it's easy for me to spot that. 
**JP Bowditch (theythem)** *[46:32]*: No, I'm. Look, I'm connected to the real database or I should be. 
**Jacqueline Reverand** *[46:37]*: Values did not save to the real database. Like the I. 
**JP Bowditch (theythem)** *[46:40]*: No, I understand that but like I signed in with my oauth and everything. 
**Jacqueline Reverand** *[46:46]*: But the targets aren't in Salesforce. Salesforce. 
**JP Bowditch (theythem)** *[46:50]*: Right, right. 
**Jacqueline Reverand** *[46:51]*: So they should be saving to a table in our SQL, but it looks like they're not saving to that location. And you're also pulling from wherever they did save to. 
**JP Bowditch (theythem)** *[47:05]*: That's right. Yeah. So either a table reference got lost. Oh, maybe. Oh, we need to create the table. I think I didn't create. I think maybe I didn't create the table out of respect for your database. 
**Jacqueline Reverand** *[47:24]*: I think I did that. So check. 
**JP Bowditch (theythem)** *[47:26]*: Okay. 
**Jacqueline Reverand** *[47:27]*: Yeah, cool. Okay, cool. Yeah, I'm happy to help test. I'm happy to take a pass. Whatever you want. Just keep me posted. And yeah, I think like the final touches going. 
**JP Bowditch (theythem)** *[47:47]*: Yeah, I think. Let me keep working on it. There's enough to squash here. 
**Jacqueline Reverand** *[47:54]*: And then. 
**JP Bowditch (theythem)** *[47:54]*: Maybe we can do some pair building when I'm in person. Cool. I need to think. I think also it will help me to, once we have the MVP live to assess all the additional work that needs to be done and parallelize it. Yeah, that way you could. And we could talk about which. Which like parallel you would want to take. 
**Jacqueline Reverand** *[48:15]*: Yeah. 
**JP Bowditch (theythem)** *[48:16]*: If you have capacity. 
**Jacqueline Reverand** *[48:18]*: Yeah, Yeah. I want to down to contribute. 
**JP Bowditch (theythem)** *[48:23]*: You have been Jack. These are. This is extremely helpful for me. So you are contributing massively. I mean, you help. You gave me the best feedback and now the progress page looks awesome. So it's good. Yeah, you're. You're, I think, doing what I need you to do. 
**Jacqueline Reverand** *[48:42]*: Great. 
**JP Bowditch (theythem)** *[48:43]*: Yeah,. 
**Jacqueline Reverand** *[48:45]*: That's great. Let me know what I can. 
**JP Bowditch (theythem)** *[48:48]*: Yeah, no, I really like this. I. I do. I do take issue with Devica is. Is on fire because some of these are definitely my wins. 
**Jacqueline Reverand** *[48:57]*: But yeah, I just wanted to show him. I just wanted to show him that we're making progress and like, no, I get building on top of, you know, the pinks that were coming in. 
**JP Bowditch (theythem)** *[49:06]*: He's. He's excited about it. He's genuinely excited about it. He. There's Just other things going on. 
**Jacqueline Reverand** *[49:12]*: Right, Cool. I will keep working. Like, try not to overthink this. I feel like this phase of finishing something can go really quickly because it's mostly front end stuff and like. Okay, so try to. 
**JP Bowditch (theythem)** *[49:30]*: No, my plan is to not overthink it. My plan is to not do anything. I'm pausing. All the other dev work that I have planned, there's a lot. But, like, I'm pausing. Especially after the Hudson Ferris call yesterday. It's clear they want Pebble. Like, Nick really wants pebble as soon as possible. 
**Jacqueline Reverand** *[49:50]*: I missed that. But it sounds like they are trying to buy those tools. 
**JP Bowditch (theythem)** *[49:55]*: Yeah. Which is Pebble. Yeah, it is a worse. Yeah, it is a worse version of pebble. And I think it is just because Nick is like, he just wants something immediately and he is excited that we're building something, but he's like, I think he doesn't care and is like, let's just use this, even if it's only for the next three weeks. Because he needs. He needs the research done and, like, no one's doing it. 
**Jacqueline Reverand** *[50:22]*: Right. 
**JP Bowditch (theythem)** *[50:23]*: Nothing is assigned to me right now. I have no portfolio right now. So I'm happy to just keep building. 
**Jacqueline Reverand** *[50:31]*: Yeah. 
**JP Bowditch (theythem)** *[50:31]*: And working with Andrew, who likes to assign me things. 
**Jacqueline Reverand** *[50:35]*: Well, yeah, I know that Dave really wants us not to buy those products. 
**JP Bowditch (theythem)** *[50:42]*: I really don't want to buy. They're bad products. Like, ours will be much better. It won't have all the fancy UI right away. Like, because it's going to do a lot of like. But we will improve that. The brief, the swarms work. I've tested them. 
**Jacqueline Reverand** *[50:57]*: Yeah. 
**JP Bowditch (theythem)** *[50:57]*: Cool. 
**Jacqueline Reverand** *[50:58]*: Okay. 
**JP Bowditch (theythem)** *[50:59]*: Yeah. 
**Jacqueline Reverand** *[50:59]*: I'm thinking about, like, maybe we can do like a hackathon or some sort of. Like, I actually think with us and Nick and Dave to just like, build this in a day and then also just prove. 
**JP Bowditch (theythem)** *[51:11]*: Build what in a day? 
**Jacqueline Reverand** *[51:13]*: Like, a simple replacement for whatever these tools are. 
**JP Bowditch (theythem)** *[51:18]*: Like, just so I would respectfully ask that you let me. Please let me, like, ship something. I've been working for weeks on this and I don't want to, like, hackathon it. I want to ship what I've worked on and then get feedback on it. Like, please, I am begging you all. Like, I have taken this Claude Certified Architect course and, like, I am taking this very seriously and I really want. I don't want to own it. Like, people can take it and run with it however they want, but, like, just let me present the, like, the work I've done. Like, I built Pebble. Yes. Pebble is Going to replace those tools. 
**Jacqueline Reverand** *[51:57]*: Great. Yeah. I'm happy for that to be the case. I just. I'm saying as an exercise to, like. Because Dave's, like, pissed off that Nick is wanting to buy these tools, doesn't understand how easy they are to build, and is just, like, showing lack of AI native. So I'm like, maybe just getting us all in the room and showing, like, proof of concept could help. 
**JP Bowditch (theythem)** *[52:20]*: That's what I'm. So that's what I'm asking for. But I need, like, another week because we gotta roll out bedrock. Right? Like, and we gotta get bedrock working well. And then. Jack, to be honest, I think the parallel. Parallelization could be. You keep refining bedrock in the ways that I've already planned a ton. You can just take all those plans and then improve them. And I'm sure you do great with that. Or. Or you can take pebble, but I feel like I know Pebble a lot better than anyone else. 
**Jacqueline Reverand** *[52:49]*: Yeah, I'm not trying to take that from you. I don't know what that is. 
**JP Bowditch (theythem)** *[52:53]*: I also don't, like, I'm not. I'm not precious about the ownership of it. I just am like, let me get to the MVP and present it. 
**Jacqueline Reverand** *[53:01]*: Yeah. 
**JP Bowditch (theythem)** *[53:02]*: Because it's almost there. I just haven't had any time to work on it in the last two weeks. I've been purely on Bedrock and the website pitch. You know, the pitch. Website stuff and those. Those side by side. I don't have enough brain. I don't have the brain space to do pebble at the same time. Because pebble is too complicated. It's just so. It's so much more complicated to get right. 
**Jacqueline Reverand** *[53:24]*: How about this? Why don't we try to, like, just launch this on. 
**JP Bowditch (theythem)** *[53:30]*: Launch Bedrock on Tuesday, Wednesday, Tuesday, Tuesday. 
**Jacqueline Reverand** *[53:37]*: You. You do what you can through, like, Monday night. Get it as good as you can. I will take it from there and do whatever's left, and then we can just push it. 
**JP Bowditch (theythem)** *[53:50]*: Great. 
**Jacqueline Reverand** *[53:50]*: Let's do it. 
**JP Bowditch (theythem)** *[53:51]*: Yes, I will. I am gonna try and have everything ready to go by. Like, can we set a time on Monday? Another, like, hour for us? 
**Jacqueline Reverand** *[54:01]*: Yeah, let's see. Are you. Are you coming in? I'm. I want to go to that event. 
**JP Bowditch (theythem)** *[54:05]*: Oh, right. Yeah, Shoot. I'm gonna. I'm gonna be at that event. I'm gonna be at that event. Why don't we do build together? 
**Jacqueline Reverand** *[54:16]*: It's kind of hard for me because I actually can't build during those times because I'm, like, helping people. 
**JP Bowditch (theythem)** *[54:21]*: Then we should target Wednesday for launch. Because we. Let's do that. Let's target Wednesday for launch and you and I like really dig into this. 
**Jacqueline Reverand** *[54:33]*: Okay. 
**JP Bowditch (theythem)** *[54:34]*: On Tuesday. Do you have time Tuesday? 
**Jacqueline Reverand** *[54:36]*: Yes, I do. Tuesday at like 1. Oh, shoot. I'm gonna be out next. The second half of next week. I can still work through like Tuesday night, but we should try to deploy it on Tuesday. So. 
**JP Bowditch (theythem)** *[54:51]*: Okay. Can I block. Can I block a lot of time? And you move some of these other things like your Jack Nick, AI systems thing that could move. Right. Because like if we can block off 3 to 6:30, we can absolutely launch it then we can get anything done that will be remaining to be done in that amount of time. I'm going to have it like fully rolled up and polished as much as possible by then. Or would you want to meet in the morning first and then. Yeah, can we do you tell me. My, my. My calendar is much more flexible. I can move anything. 
**Jacqueline Reverand** *[55:31]*: I can do like 12:30 to 1:30 or. Okay. Or I could do like Monday. 
**JP Bowditch (theythem)** *[55:52]*: We should, we should have a little time. One day. 
**Jacqueline Reverand** *[55:54]*: 11:30. 
**JP Bowditch (theythem)** *[55:56]*: Sure. Let's check in each day. 
**Jacqueline Reverand** *[55:59]*: Okay. 
**JP Bowditch (theythem)** *[55:59]*: Bedrock launch. 
**Jacqueline Reverand** *[56:01]*: Because I would love to. 
**JP Bowditch (theythem)** *[56:03]*: I can't do in the. I'm gonna be at that event. I'm supporting France. 
**Jacqueline Reverand** *[56:08]*: You're not gonna come in beforehand? 
**JP Bowditch (theythem)** *[56:10]*: I will come in beforehand, but I have to be at Henry street at 11:15 and I've got an AI JI so I don't really have any time in the morning. 
**Jacqueline Reverand** *[56:18]*: Yeah. 
**JP Bowditch (theythem)** *[56:20]*: So the only time is build together. Basically. 
**Jacqueline Reverand** *[56:23]*: Let's do 2:30 to 3:30 and I'll move the jobs PRD because Damon can't join anyway. What do you think? 
**JP Bowditch (theythem)** *[56:31]*: I might. It depends on how long they want me to stay at the Henry street community. I. But sure. 
**Jacqueline Reverand** *[56:39]*: Let's do two three and if we run over. It's fine. 
**JP Bowditch (theythem)** *[56:44]*: No, you know what? I've just decided I will make sure I leave that early because this is way more important. I do want to support Francis because I think community development is really important and it too often is treated as like a side thing. 
**Jacqueline Reverand** *[56:58]*: Agree. 
**JP Bowditch (theythem)** *[57:04]*: And then could we do another time slot? Oh, I just created one for us. I'm going to delete yours or you should delete yours. So. And then how about one more at the. Towards the end? How about after your thing with Nick? 4:00Pm yeah, that's. Honestly, I have a feeling he's. Since I'm in the office, he's going to be like, let's talk about bedrock. Yeah, like that's what he did last time or two weeks ago. Right. Like so. But let's have another time for four to five and that's when we'll be like, okay, it's going to go live. 
**Jacqueline Reverand** *[57:43]*: Yeah, Great. 
**JP Bowditch (theythem)** *[57:44]*: Okay. 
**Jacqueline Reverand** *[57:45]*: So Monday night I can try to work on this on Monday night. So you get to where you can before. 
**JP Bowditch (theythem)** *[57:51]*: Yes. 
**Jacqueline Reverand** *[57:52]*: End of day on Monday and then I'll. 
**JP Bowditch (theythem)** *[57:54]*: Understood. 
**Jacqueline Reverand** *[57:55]*: Forward. 
**JP Bowditch (theythem)** *[57:56]*: Well, I let's. Let's still like par. Build it because you're going to be gone and like if something needs to be fixed, I'll be the one to have to fix it while you're gone. Or wait. So like I'd rather not fully shift it in terms of parallelization. Like, let's keep it. Does that make sense? Like we'll keep it collaborative and pair building it or whatever. 
**Jacqueline Reverand** *[58:19]*: Yeah, sure. 
**JP Bowditch (theythem)** *[58:20]*: Okay. Okay, Cool. Great. I'm excited. 
**Jacqueline Reverand** *[58:25]*: Me too. 
**JP Bowditch (theythem)** *[58:26]*: Yeah, I think this is going to be great. And I'm, I am genuinely really excited to get pebble integrated into it because I think it turns it from like, oh, this is kind of cool. Like, and it does things better than Salesforce to like, whoa, this is like, I'm no longer doing manual data entry. Like, that's where I really want to get to. 
**Jacqueline Reverand** *[58:48]*: I'm excited by that. And the other use of Pebble. I was surprised to hear that like I thought of pebble as a research agent, not a. Not as much of a doer. So I'm wondering if we should like,. 
**JP Bowditch (theythem)** *[59:04]*: It can be separate if you want. 
**Jacqueline Reverand** *[59:05]*: Yeah. 
**JP Bowditch (theythem)** *[59:06]*: But I don't know. But it has the ability to do both. And the research swarms, sometimes you want to spin those up for. There's. Sorry. They're not just research swarms. They're swarms to do any. All kinds of things, including deep like editing of the database in a really careful way. 
**Jacqueline Reverand** *[59:28]*: Cool. 
**JP Bowditch (theythem)** *[59:28]*: Yeah. So some of that is just like queries. Right. And rule based stuff. But then if you want to go really deep, it makes sense sometimes to like spin up a team. Just like you would spin up a team to explore in parallel a really extensive repo. 
**Jacqueline Reverand** *[59:44]*: Right. 
**JP Bowditch (theythem)** *[59:46]*: So it's the same principle. 
**Jacqueline Reverand** *[59:49]*: Cool. 
**JP Bowditch (theythem)** *[59:51]*: And then there's cool stuff like thinking about different agent patterns. I would love to be able to eventually like talk to you more about Jack, like. So are you planning to take that Claude certified Architect course? 
**Jacqueline Reverand** *[01:00:02]*: I would like to. I don't know when I'm gonna make the time. 
**JP Bowditch (theythem)** *[01:00:06]*: I've only gotten maybe a third of the way through it, to be honest, but it's Amazing. And like, it's. A lot of it is just so intuitive. Like, this works like a murmuration versus like a beehive. You know, the murmuration. Like there's no one in charge. They just are like following other. All reacting to each other. That's a. That's an agent team. 
**Jacqueline Reverand** *[01:00:28]*: Yeah. 
**JP Bowditch (theythem)** *[01:00:29]*: Orchestrator Worker is where you have one point of control, you know, but you can combine these patterns, which is what pebble does. So it's Orchestrator with agent teams working in little murmurations, but they're still harnessed a little bit, you know what I mean? To keep them on to. To avoid like goal drift and stuff like that, which the murmuration can be really powerful for. But it has a tendency to, like, just find its own direction and go. Go for it. It's very cool. Like, but sometimes that's better. You use an agent team when you don't really know where you where like the. The discovery of that. It like part of the discovery is figuring out the direction it's supposed to go. You know what I mean? So anyway, it's a lot of cool stuff, but are you using like Lang. 
**Jacqueline Reverand** *[01:01:25]*: Chain or Lang Graph or any of those? 
**JP Bowditch (theythem)** *[01:01:27]*: Nope, not yet. We could. 
**Jacqueline Reverand** *[01:01:32]*: That's more like upscale myself. But. 
**JP Bowditch (theythem)** *[01:01:36]*: Yeah, I mean, isn't that more for like, rag models and stuff? 
**Jacqueline Reverand** *[01:01:40]*: I think it's for like, agent building. We're building an agent, like a coding agent, basically for the factory. But I haven't gotten that deep into it yet. 
**JP Bowditch (theythem)** *[01:01:58]*: Nice. 
**Jacqueline Reverand** *[01:01:59]*: We'll let you know what I learned. 
**JP Bowditch (theythem)** *[01:02:01]*: So the coding agent will just work on the repos for us. 
**Jacqueline Reverand** *[01:02:06]*: Yeah, like, we actually. I went to this AI event. 
**JP Bowditch (theythem)** *[01:02:11]*: I'm like, I don't want that turned on for mine. Like, I just don't. I don't even trust Claude to do things in auto mode. I'm like, I never use. I'm like, do not use auto mode. 
**Jacqueline Reverand** *[01:02:23]*: I don't trust we're going to start with a small scope. Like small bug requests and like really small UI things. And like, the goal is. 
**JP Bowditch (theythem)** *[01:02:33]*: No, it's cool. That is. That is building for the model six months from now. 
**Jacqueline Reverand** *[01:02:37]*: Right. 
**JP Bowditch (theythem)** *[01:02:37]*: That is a very good example, I think of that. It's like, eventually it should be that good. Yes. 
**Jacqueline Reverand** *[01:02:43]*: Yeah. And you don't need the channel. I already have an agent from a few months ago that I built for Frances where she can just like request features and maybe I can show you an example here. 
**JP Bowditch (theythem)** *[01:02:57]*: Okay. She can request also, I need to share with you. I've built title pool personally. 
**Jacqueline Reverand** *[01:03:05]*: Yeah. Yeah. 
**JP Bowditch (theythem)** *[01:03:06]*: And I'VE also. I'm building Body Double, a productivity app. Well, so my partner and I have like Neurodiverse diversity thing. So maybe you've heard of body doubling with like an adhd. 
**Jacqueline Reverand** *[01:03:20]*: I haven't, but I should figure that out. 
**JP Bowditch (theythem)** *[01:03:23]*: It's this idea that like, for it helps people with ADHD like stay on task to just like match what the other person is doing. So it's basically like our shared calendar and it's trello shared calendar and split wise all in one. 
**Jacqueline Reverand** *[01:03:39]*: Nice. 
**JP Bowditch (theythem)** *[01:03:40]*: But in a. But in like a soft. In a. In a way that's built for our like neurodiversity. So that one isn't going to become open source, but I am actually going to launch it on the Apple Store. It's going to be a real iOS. I have an Apple Developer program license and so I'm like learning how to build. This is why I mentioned like mobile. I'm like, I'm currently building a real iOS app and I'm going to launch it probably in the next few weeks and then title pool is pretty close to ready for open source launch. I just am so scared of accidentally leaking my information that I'm like doing a billion different tests. But it basically takes your entire Spotify streaming history, your entire itunes library, and it allows you to create smart playlists and sync everything to title. 
**Jacqueline Reverand** *[01:04:36]*: Awesome. 
**JP Bowditch (theythem)** *[01:04:37]*: Yeah. And it works and it's really beautiful. I've built like the UI is a here. I'm not going to show it to you right now because I can't. But I have it right here. I'll just like cheat a little bit. 
**Jacqueline Reverand** *[01:04:51]*: Oh, looks nice. 
**JP Bowditch (theythem)** *[01:04:54]*: It's. It's the Jersey Shore. It's in Svelte. Have you heard of Svelte? 
**Jacqueline Reverand** *[01:05:00]*: Yeah, I think so. 
**JP Bowditch (theythem)** *[01:05:01]*: It's like a, it's a new. It's like react, but a little bit nicer for you. If you're like really wanting to make the, the animations like really good. Which I was like, there's not a lot to do here other than create smart playlists and like check for the unmatched. Because not everything matches cleanly either. Which is why you have to like pay companies to do this if you want to switch from Spotify to Tidal. And I'm like, why would I pay anyone to do this? I can just build my own version of it. That can also be a love letter to my partner who is motivating me to switch to title. 
**Jacqueline Reverand** *[01:05:37]*: Nice. 
**JP Bowditch (theythem)** *[01:05:38]*: Yeah, so there's like little inform. There's like planes and Stuff that fly by with like the banner, shows you the number of matches and it's just fun. I'm having so much fun building. It's great. I keep saying this, but I feel like I'm in college again where I'm like, I haven't been like learning this fast in a long time. 
**Jacqueline Reverand** *[01:05:58]*: Yeah. 
**JP Bowditch (theythem)** *[01:05:58]*: And I think it's all because of AI and I've made the breakthrough. Like, I'm not personally scared of AI anymore in like the near term. I'm not worried about losing my job due to it because I'm a builder. I can build with it. 
**Jacqueline Reverand** *[01:06:12]*: Yeah. 
**JP Bowditch (theythem)** *[01:06:13]*: It's actually pretty easy. 
**Jacqueline Reverand** *[01:06:15]*: I am a little worried for myself. But we'll see. I feel like we're. 
**JP Bowditch (theythem)** *[01:06:21]*: We'll just adapt, Jack. We'll just adapt. We'll. 
**Jacqueline Reverand** *[01:06:24]*: I know, but do something. What happens when all the problems are solved is the question. Like, what happens when we're running really efficiently? 
**JP Bowditch (theythem)** *[01:06:31]*: There's. That. That is going to take so long and then it's a problem of scaling, right? 
**Jacqueline Reverand** *[01:06:37]*: Yeah. Yeah. 
**JP Bowditch (theythem)** *[01:06:38]*: As long as it's doing well. 
**Jacqueline Reverand** *[01:06:40]*: Sure. 
**JP Bowditch (theythem)** *[01:06:41]*: But pursuit is. Is gonna be doing well. I am confident. And I've already talked to Nick about this. I'm like, we can raise a $100 million endowment for the AI Jobs Institute. It is what the high net worth individuals and like the big names he has. It will just make sense to them and it won't feel like they're throwing away their money and it gets spent right away. It will seed the future. Like. 
**Jacqueline Reverand** *[01:07:08]*: Yeah. 
**JP Bowditch (theythem)** *[01:07:08]*: The returns on a hundred million dollars are more than enough to like not fill our full budget, obviously, but like give us a good, like solid grounding for the tech hub forever. 
**Jacqueline Reverand** *[01:07:22]*: Yeah. 
**JP Bowditch (theythem)** *[01:07:23]*: There's a reason why every major institution is set up that way. Right. All the universities are set up that way. So there's no reason we can't do it. We're building our own tech hub. Like so. Yeah. I'm excited. I think we're gonna raise a lot of money this year. 
**Jacqueline Reverand** *[01:07:41]*: Awesome. 
**JP Bowditch (theythem)** *[01:07:41]*: And next year. Yeah. 
**Jacqueline Reverand** *[01:07:44]*: Okay. Let me show you my agents, please. 
**JP Bowditch (theythem)** *[01:07:48]*: Sorry. I just got excited and I wanted to show you title pool. 
**Jacqueline Reverand** *[01:07:51]*: That's okay. Yeah. It looked really cool. I want to try it. 
**JP Bowditch (theythem)** *[01:07:53]*: I also just love coming up with the names for these things. It's just fun. It's so much fun. 
**Jacqueline Reverand** *[01:07:58]*: Yes. Okay. So this is one of them. Basically, like you can tag it in the platform. Yeah. I initially named him Bob, but we're working on it. It'll probably be the factory. 
**JP Bowditch (theythem)** *[01:08:12]*: Yeah. Factory is good. 
**Jacqueline Reverand** *[01:08:13]*: Yeah. 
**JP Bowditch (theythem)** *[01:08:13]*: But Keep Bob as the picture. Yeah, that's fun. 
**Jacqueline Reverand** *[01:08:20]*: But it says, okay, thank you. It'll ask you questions if you need. It looks at this like the repo and it's like, all right, is this right? I'm like, yeah, do it. And then it says working on it. It tells you what it did and it actually sends you a screenshot of the change too, which I think is really cool. 
**JP Bowditch (theythem)** *[01:08:39]*: That's cool. How is it actually doing this? What's happening? Is it one agent? Is it an. Like, how. Where is it running the agent? What models does it have access to? Like that kind of stuff? What skills does it have access to? 
**Jacqueline Reverand** *[01:08:59]*: It's all running in Google Cloud. Run an app engine. I don't even really remember. I think there's like multi agent things going on. But mostly I was concerned about putting guardrails on it so that it can only touch certain pages and it can only respond to the right types of requests and things like that. So it's a pretty small scope, but yeah, it's pretty cool. And then it like does the PR for you and can you. 
**JP Bowditch (theythem)** *[01:09:28]*: What would be the best way for you to show. Share this with me so I can learn from it? 
**Jacqueline Reverand** *[01:09:34]*: I can. I think I have. I think I've pushed this one. Yeah. And I'll send it to you. And then my other agent is. This one actually is functional. 
**JP Bowditch (theythem)** *[01:09:43]*: I'm not sure I would even use it right away, to be honest. But it's more like I want to be able to look at the repo and learn from it. For Pebble. 
**Jacqueline Reverand** *[01:09:53]*: Right. And this one, this is Cassandra. 
**JP Bowditch (theythem)** *[01:09:56]*: That's so cool. 
**Jacqueline Reverand** *[01:09:57]*: My alert agent. Yes. But like she is hooked up to all of the different scheduled agents or things like automations that run such as like grading the. All the homework and the tasks and even grading like admissions applications and all these things. She's hooked up to that. And the problem were facing is like, I don't know when those things stop working. And then like a week later Frances will be like, oh, none of them have been graded. What happened? So now she monitors the logs all the time and then figures out that's so cool. And just like does it. Which is crazy. 
**JP Bowditch (theythem)** *[01:10:34]*: And it's been like, fixes. It actually fixes. 
**Jacqueline Reverand** *[01:10:37]*: It fixes. It creates a PR auto heal. Yeah. 
**JP Bowditch (theythem)** *[01:10:41]*: Wow. Can you add me to this or like, whatever. I'm not trying to. I'm not trying to get access to something I shouldn't have access to. So let me just. 
**Jacqueline Reverand** *[01:10:52]*: No, you can have anything. 
**JP Bowditch (theythem)** *[01:10:53]*: But if this, I mean, Even just if I could be added to this channel to see how it works. 
**Jacqueline Reverand** *[01:11:00]*: Yeah, yeah. 
**JP Bowditch (theythem)** *[01:11:02]*: That is really cool. And I love the. The reference. Like. Yes, I love that so much. 
**Jacqueline Reverand** *[01:11:11]*: Yeah, thank you. Okay. Yeah, you're in this one. I have a few. So, Agent Sandbox, how do I get. 
**JP Bowditch (theythem)** *[01:11:18]*: How do I get ca. How do I get it to show Cassandra? Maybe I have to update my Slack. It just says Cassandra, but I don't see the like, image next to it. 
**Jacqueline Reverand** *[01:11:30]*: Weird. But yeah, I'll show you. I'll send you the repos. It's been a while. I mean, I built those both as kind of just like fun side projects, so they're not perfect, but Twan and I added you to Agent Sandbox. This is just where I like test any AI stuff that I don't want everyone else being flooded with. So feel free to use that as well. 
**JP Bowditch (theythem)** *[01:11:54]*: Sorry, hold on. Someone text Slacked me something. The next week we're launching. Sorry, what was. Can you say that last thing again? I'm sorry. 
**Jacqueline Reverand** *[01:12:03]*: Just add a few to Agent Sandbox. It's just a Slack space for experimenting that's safe and so that you don't have to like flood other people with your agent stuff. So feel free to use it. 
**JP Bowditch (theythem)** *[01:12:16]*: Awesome. This is so cool. I have not started building agents in Slack at all, but it seems really cool. 
**Jacqueline Reverand** *[01:12:25]*: Yeah. 
**JP Bowditch (theythem)** *[01:12:26]*: Do you use the MCP client bot a lot? 
**Jacqueline Reverand** *[01:12:31]*: I don't know which one is that? 
**JP Bowditch (theythem)** *[01:12:35]*: I don't know. It's just one that auto loaded in my. I have Claude, but I haven't really used it to be honest. But it is mcp. It's MCP Here, I'll just share my screen. 
**Jacqueline Reverand** *[01:12:46]*: Oh yeah, I see. 
**JP Bowditch (theythem)** *[01:12:48]*: Well, Clint, it's in the top right here. This is where you can find your bots. 
**Jacqueline Reverand** *[01:12:54]*: Oh, yeah. 
**JP Bowditch (theythem)** *[01:12:55]*: And I don't know what it is. 
**Jacqueline Reverand** *[01:12:57]*: I don't know what this might be, Carlos creating something for our database, but. 
**JP Bowditch (theythem)** *[01:13:02]*: Oh, okay. That's probably what it is then. Anyway. 
**Jacqueline Reverand** *[01:13:07]*: Cool. Anyway, I don't actually use much in Slack, but I would like more alerts in there. 
**JP Bowditch (theythem)** *[01:13:13]*: I think it would also be helpful for me because I don't yet have a mental model of like where you run these kinds of things, you know what I mean? Like, I'm just doing everything locally right now, but I'm now moving to everything, right? So I'm building a server for Body Double, so. Because obviously it has to have actually a secure server to ship it on the iOS store and have it sync properly. Otherwise you have to have like a computer running it all the time. 
**Jacqueline Reverand** *[01:13:46]*: Yeah, you should check out Google Cloud for personal stuff. 
**JP Bowditch (theythem)** *[01:13:50]*: It recommended Firebase and Google Cloud for authentication. I think. 
**Jacqueline Reverand** *[01:13:58]*: Cool. Firebase is part of Google Cloud, I think. 
**JP Bowditch (theythem)** *[01:14:02]*: Sorry. Yeah, that. 
**Jacqueline Reverand** *[01:14:03]*: Yeah. Right, right. Yeah. So cool. Create a project in there. You can do pretty much anything within the Google Cloud world, so. And it's all very cheap at a small scale, so. 
**JP Bowditch (theythem)** *[01:14:18]*: At a small scale, right, yeah. 
**Jacqueline Reverand** *[01:14:19]*: Yeah. Cool. 
**JP Bowditch (theythem)** *[01:14:21]*: Thanks Jack. I'm excited. Lots of good work and I appreciate your help and I will get back to you soon. And targeting. Yeah, I'll have a lot done Monday morning that I'll send you and then I'll try to let you know like this is what I'm be working on in the meantime. Maybe by then I'll have like a roll up because I was talking to Claude and it's like I can keep working in dev while you're reviewing whatever roll up for that targets main, you know, and then the next roll up will be ready sooner. Yeah. So does that sound good for like how we can work through the next few days? 
**Jacqueline Reverand** *[01:14:56]*: Yeah, I just, I'm somewhat new to being like the person that's managing merge conflict, so I want to be a little careful, but. Okay, let's try it. 
**JP Bowditch (theythem)** *[01:15:06]*: Okay. Well, I've usually been trying to check those. That's why I closed 102 before because I was like, this will be clean. I could have left it open but it. I was like this is going to be cleaner for Jack if I close it first because it's not. It was no longer really relevant and it would have conflicted. 
**Jacqueline Reverand** *[01:15:23]*: Got it. 
**JP Bowditch (theythem)** *[01:15:24]*: So I just closed it and only kept the like three things for later that are going to be relevant for a remaining Sprint. It's like just a test Sprint basically. But the test suite is good. You should, you should run that test suite whenever you want. 
**Jacqueline Reverand** *[01:15:38]*: Yeah, I'll check it out. 
**JP Bowditch (theythem)** *[01:15:39]*: Yeah. Okay. All right, thanks. 
**Jacqueline Reverand** *[01:15:42]*: Thank you. Have a great weekend. 
