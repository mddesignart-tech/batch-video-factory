import type { Difficulty, IdiomCategory, Region } from "@/domain/enums";

/**
 * Seed idiom library.
 *
 * `literalMeaning` is written as a *harmless cartoon visual gag*, not as a
 * literal description. Several common idioms ("break a leg", "bite the bullet",
 * "kick the bucket") have violent literal readings; per the content rules those
 * are re-staged as soft slapstick where nothing and nobody gets hurt, so the
 * downstream image and video prompts inherit safe framing by construction.
 */

export interface SeedIdiom {
  phrase: string;
  meaning: string;
  literalMeaning: string;
  exampleSentence: string;
  category: IdiomCategory;
  difficulty: Difficulty;
  region: Region;
}

export const SEED_IDIOMS: SeedIdiom[] = [
  // ------------------------------------------------------------- classics ---
  {
    phrase: "Break a leg",
    meaning: "Good luck",
    literalMeaning:
      "He thinks he must break his own leg, so he wraps it in a giant cartoon bandage before the show.",
    exampleSentence: "Break a leg on your interview!",
    category: "Funny Expressions",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Piece of cake",
    meaning: "Very easy",
    literalMeaning:
      "He shows up to a hard exam holding an actual slice of cake on a plate.",
    exampleSentence: "That test was a piece of cake!",
    category: "Food",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Spill the beans",
    meaning: "Tell a secret",
    literalMeaning:
      "He tips over an enormous jar and beans bounce everywhere in slow motion.",
    exampleSentence: "Come on, spill the beans! What did she say?",
    category: "Food",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Hit the books",
    meaning: "Study hard",
    literalMeaning:
      "He gently boxes a stack of textbooks while wearing oversized foam gloves.",
    exampleSentence: "I have to hit the books tonight.",
    category: "School",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Under the weather",
    meaning: "Feeling sick",
    literalMeaning:
      "He stands under a tiny personal rain cloud that follows him indoors.",
    exampleSentence: "I am under the weather today, so I will stay home.",
    category: "Weather",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Hold your horses",
    meaning: "Wait and be patient",
    literalMeaning:
      "He tries to hug two cartoon horses at once and they carry him away.",
    exampleSentence: "Hold your horses, the movie has not started yet.",
    category: "Animals",
    difficulty: "Beginner",
    region: "US",
  },
  {
    phrase: "Let the cat out of the bag",
    meaning: "Reveal a secret by accident",
    literalMeaning:
      "A very smug cat climbs out of a shopping bag and struts off with the secret.",
    exampleSentence: "He let the cat out of the bag about the party.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Cost an arm and a leg",
    meaning: "Be very expensive",
    literalMeaning:
      "At the checkout he offers a cartoon mannequin arm and leg as payment.",
    exampleSentence: "That phone cost an arm and a leg.",
    category: "Money",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "When pigs fly",
    meaning: "Never; it will not happen",
    literalMeaning:
      "A pig with tiny paper wings flaps hopefully past the window.",
    exampleSentence: "He will clean his room when pigs fly.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Hit the sack",
    meaning: "Go to bed",
    literalMeaning:
      "He punches a giant pillow sack, then falls asleep standing next to it.",
    exampleSentence: "I am tired. I am going to hit the sack.",
    category: "Daily Life",
    difficulty: "Beginner",
    region: "US",
  },
  {
    phrase: "Cold feet",
    meaning: "Suddenly too nervous to do something",
    literalMeaning:
      "His feet are frozen in two blocks of cartoon ice and he waddles around.",
    exampleSentence: "He got cold feet before his speech.",
    category: "Body",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "On cloud nine",
    meaning: "Extremely happy",
    literalMeaning:
      "He sits on a fluffy cloud with a big number nine painted on the side.",
    exampleSentence: "She was on cloud nine after the good news.",
    category: "Weather",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Fish out of water",
    meaning: "Feeling out of place",
    literalMeaning:
      "A cartoon fish in a business suit sits nervously in an office chair.",
    exampleSentence: "At the party I felt like a fish out of water.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Bite the bullet",
    meaning: "Accept something difficult and do it anyway",
    literalMeaning:
      "He carefully nibbles a giant soft rubber bullet like it is a snack.",
    exampleSentence: "I will bite the bullet and tell my boss the truth.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  // ------------------------------------------------------------------ food ---
  {
    phrase: "Bring home the bacon",
    meaning: "Earn money for the family",
    literalMeaning:
      "He staggers through the front door carrying one absurdly huge strip of bacon.",
    exampleSentence: "She works hard to bring home the bacon.",
    category: "Food",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Butter someone up",
    meaning: "Say nice things to get a favour",
    literalMeaning:
      "He politely spreads butter on his boss's sleeve with a tiny knife.",
    exampleSentence: "He is buttering up the teacher for a better grade.",
    category: "Food",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "In a nutshell",
    meaning: "In a few words; briefly",
    literalMeaning:
      "He squeezes his entire presentation inside a walnut shell and hands it over.",
    exampleSentence: "In a nutshell, we need more time.",
    category: "Food",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Take it with a grain of salt",
    meaning: "Do not fully believe it",
    literalMeaning:
      "He listens to gossip while balancing one single salt grain on his finger.",
    exampleSentence: "Take his story with a grain of salt.",
    category: "Food",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Cool as a cucumber",
    meaning: "Very calm",
    literalMeaning:
      "He sits in a chaotic room wearing sunglasses and holding a chilled cucumber.",
    exampleSentence: "During the test she was cool as a cucumber.",
    category: "Food",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Have bigger fish to fry",
    meaning: "Have more important things to do",
    literalMeaning:
      "He drags an enormous cartoon fish toward a tiny frying pan.",
    exampleSentence: "I cannot argue now, I have bigger fish to fry.",
    category: "Food",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Full of beans",
    meaning: "Full of energy",
    literalMeaning:
      "He bounces off the walls while beans pour out of his backpack.",
    exampleSentence: "The kids are full of beans this morning.",
    category: "Food",
    difficulty: "Intermediate",
    region: "UK",
  },
  {
    phrase: "The icing on the cake",
    meaning: "An extra good thing on top of something already good",
    literalMeaning:
      "He solemnly places one tiny drop of icing on a cake and applauds himself.",
    exampleSentence: "Winning was great, and the trophy was the icing on the cake.",
    category: "Food",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Egg on your face",
    meaning: "Look foolish because of a mistake",
    literalMeaning:
      "A cartoon egg gently splats on his forehead and he keeps smiling politely.",
    exampleSentence: "He had egg on his face after his answer was wrong.",
    category: "Food",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Go bananas",
    meaning: "Become very excited or silly",
    literalMeaning:
      "He turns into a happy tornado of banana peels and confetti.",
    exampleSentence: "The crowd went bananas when the team scored.",
    category: "Food",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Sell like hotcakes",
    meaning: "Sell very quickly",
    literalMeaning:
      "A stack of pancakes sprints out of the shop door on tiny legs.",
    exampleSentence: "The new game is selling like hotcakes.",
    category: "Food",
    difficulty: "Intermediate",
    region: "US",
  },
  // --------------------------------------------------------------- animals ---
  {
    phrase: "Raining cats and dogs",
    meaning: "Raining very heavily",
    literalMeaning:
      "Cartoon puppies and kittens float down under tiny parachutes.",
    exampleSentence: "Take an umbrella, it is raining cats and dogs.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Wild goose chase",
    meaning: "A search that wastes your time",
    literalMeaning:
      "He sprints across a park after one very relaxed goose that keeps strolling away.",
    exampleSentence: "Looking for that shop was a wild goose chase.",
    category: "Animals",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "The elephant in the room",
    meaning: "An obvious problem nobody wants to talk about",
    literalMeaning:
      "A polite cartoon elephant sits at the meeting table sipping tea, ignored by everyone.",
    exampleSentence: "Nobody mentioned the elephant in the room.",
    category: "Animals",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Kill two birds with one stone",
    meaning: "Solve two problems with one action",
    literalMeaning:
      "He gently hands one pebble to two birds, who use it as a bird bath.",
    exampleSentence: "I walk to work to kill two birds with one stone.",
    category: "Animals",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "A little bird told me",
    meaning: "Someone told me a secret",
    literalMeaning:
      "A tiny cartoon bird whispers into his ear through a small megaphone.",
    exampleSentence: "A little bird told me it is your birthday.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Copycat",
    meaning: "Someone who copies another person",
    literalMeaning:
      "A cat with a photocopier hat follows him and copies everything he does.",
    exampleSentence: "Stop being a copycat and draw your own picture.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Straight from the horse's mouth",
    meaning: "From the original, reliable source",
    literalMeaning:
      "He holds a microphone up to a very confident talking horse.",
    exampleSentence: "I heard it straight from the horse's mouth.",
    category: "Animals",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Busy as a bee",
    meaning: "Very busy",
    literalMeaning:
      "He wears little bee wings and buzzes between four desks at once.",
    exampleSentence: "She has been busy as a bee all week.",
    category: "Animals",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Let sleeping dogs lie",
    meaning: "Do not start trouble that has already calmed down",
    literalMeaning:
      "He tiptoes past a snoring cartoon dog wearing a tiny sleep mask.",
    exampleSentence: "Do not ask him about it. Let sleeping dogs lie.",
    category: "Animals",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Get the lion's share",
    meaning: "Get the biggest part",
    literalMeaning:
      "A lion in a chef hat serves everyone tiny plates and keeps a giant one.",
    exampleSentence: "She got the lion's share of the prize.",
    category: "Animals",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Like a bull in a china shop",
    meaning: "Very clumsy in a delicate situation",
    literalMeaning:
      "A cartoon bull tiptoes through a teacup shop, wobbling everything softly.",
    exampleSentence: "He walked in like a bull in a china shop.",
    category: "Animals",
    difficulty: "Advanced",
    region: "UK",
  },
  // ------------------------------------------------------------------ work ---
  {
    phrase: "Call it a day",
    meaning: "Stop working for now",
    literalMeaning:
      "He points at a calendar and shouts a name at it until it agrees.",
    exampleSentence: "We are tired. Let us call it a day.",
    category: "Work",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Burn the midnight oil",
    meaning: "Work late into the night",
    literalMeaning:
      "He sits at his desk holding a tiny oil lamp with a very worried face.",
    exampleSentence: "I burned the midnight oil to finish the report.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Learn the ropes",
    meaning: "Learn how a job works",
    literalMeaning:
      "He studies a pile of actual ropes with a magnifying glass and takes notes.",
    exampleSentence: "Give him a week to learn the ropes.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Think outside the box",
    meaning: "Think in a new and creative way",
    literalMeaning:
      "He climbs out of a cardboard box, thinks hard, then climbs back in.",
    exampleSentence: "We need to think outside the box for this project.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Get the ball rolling",
    meaning: "Start something",
    literalMeaning:
      "He pushes a giant beach ball into the meeting room and everyone chases it.",
    exampleSentence: "Let us get the ball rolling on the new plan.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "On the same page",
    meaning: "Agreeing and understanding each other",
    literalMeaning:
      "Two people try to stand on one small sheet of paper together.",
    exampleSentence: "Let us make sure we are on the same page.",
    category: "Work",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Back to the drawing board",
    meaning: "Start again from the beginning",
    literalMeaning:
      "He drags a huge wooden drawing board back into the room, defeated.",
    exampleSentence: "The idea failed, so it is back to the drawing board.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Put your thinking cap on",
    meaning: "Start thinking carefully",
    literalMeaning:
      "He puts on a hat covered in blinking light bulbs and flashing wires.",
    exampleSentence: "Put your thinking cap on, this puzzle is hard.",
    category: "Work",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Wear many hats",
    meaning: "Do many different jobs",
    literalMeaning:
      "He balances nine hats on his head at once and slowly tips over.",
    exampleSentence: "In a small company you wear many hats.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Raise the bar",
    meaning: "Set a higher standard",
    literalMeaning:
      "He lifts a gym bar above a door frame so nobody can walk through.",
    exampleSentence: "Her project really raised the bar.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  // ----------------------------------------------------------------- money ---
  {
    phrase: "Break the bank",
    meaning: "Cost too much money",
    literalMeaning:
      "He taps a piggy bank with a feather and it politely falls apart.",
    exampleSentence: "A coffee will not break the bank.",
    category: "Money",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Tighten your belt",
    meaning: "Spend less money",
    literalMeaning:
      "He pulls his belt so tight that his trousers fold like an accordion.",
    exampleSentence: "We must tighten our belts this month.",
    category: "Money",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Money talks",
    meaning: "Money gives people power",
    literalMeaning:
      "A cartoon banknote with a tiny mouth gives a confident speech.",
    exampleSentence: "In business, money talks.",
    category: "Money",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Save for a rainy day",
    meaning: "Save money for the future",
    literalMeaning:
      "He hides coins inside an umbrella and waits hopefully for rain.",
    exampleSentence: "I save a little every month for a rainy day.",
    category: "Money",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Foot the bill",
    meaning: "Pay for something",
    literalMeaning:
      "He tries to pay the restaurant using only his left foot.",
    exampleSentence: "My uncle footed the bill for dinner.",
    category: "Money",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Cheapskate",
    meaning: "Someone who hates spending money",
    literalMeaning:
      "He rides one very old skate instead of buying a second one.",
    exampleSentence: "Do not be a cheapskate, buy her a real gift.",
    category: "Money",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Make ends meet",
    meaning: "Have just enough money to live",
    literalMeaning:
      "He pulls two ends of a short rope and they refuse to touch.",
    exampleSentence: "They work two jobs to make ends meet.",
    category: "Money",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Pay through the nose",
    meaning: "Pay far too much",
    literalMeaning:
      "He posts coins into his own nose like a piggy bank and looks proud.",
    exampleSentence: "We paid through the nose for those tickets.",
    category: "Money",
    difficulty: "Advanced",
    region: "UK",
  },
  // ------------------------------------------------------------------ body ---
  {
    phrase: "Keep an eye on it",
    meaning: "Watch it carefully",
    literalMeaning:
      "He balances a giant googly eye on top of a cooking pot.",
    exampleSentence: "Keep an eye on the soup, please.",
    category: "Body",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Give me a hand",
    meaning: "Help me",
    literalMeaning:
      "He is handed a foam novelty hand and stares at it, confused.",
    exampleSentence: "Can you give me a hand with this box?",
    category: "Body",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "All ears",
    meaning: "Listening carefully",
    literalMeaning:
      "His head is covered in tiny cartoon ears, all pointing forward.",
    exampleSentence: "Tell me the story, I am all ears.",
    category: "Body",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Pull someone's leg",
    meaning: "Joke with someone; tease them",
    literalMeaning:
      "He gently tugs his friend's trouser leg like a doorbell rope.",
    exampleSentence: "Relax, I am just pulling your leg.",
    category: "Body",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Get something off your chest",
    meaning: "Say what is worrying you",
    literalMeaning:
      "He lifts a heavy cartoon anvil off his chest and sighs with relief.",
    exampleSentence: "I need to get something off my chest.",
    category: "Body",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Head in the clouds",
    meaning: "Not paying attention; daydreaming",
    literalMeaning:
      "His head is literally inside a small cloud and he bumps into a door.",
    exampleSentence: "He has his head in the clouds again.",
    category: "Body",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Rule of thumb",
    meaning: "A simple general rule",
    literalMeaning:
      "He measures an entire building using only his thumb, very seriously.",
    exampleSentence: "As a rule of thumb, drink water every hour.",
    category: "Body",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "See eye to eye",
    meaning: "Agree with each other",
    literalMeaning:
      "Two friends stand nose to nose, staring, until both start laughing.",
    exampleSentence: "We do not see eye to eye about music.",
    category: "Body",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Butterflies in my stomach",
    meaning: "Feeling nervous",
    literalMeaning:
      "Cartoon butterflies fly out of his jacket every time he opens it.",
    exampleSentence: "I had butterflies in my stomach before the test.",
    category: "Body",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Break a sweat",
    meaning: "Work hard enough to get tired",
    literalMeaning:
      "One single cartoon sweat drop appears and he catches it in a cup.",
    exampleSentence: "He finished the race without breaking a sweat.",
    category: "Body",
    difficulty: "Intermediate",
    region: "US",
  },
  // ---------------------------------------------------------- daily life ----
  {
    phrase: "Hit the road",
    meaning: "Leave; start a journey",
    literalMeaning:
      "He high-fives the pavement politely before walking away.",
    exampleSentence: "It is late, we should hit the road.",
    category: "Travel",
    difficulty: "Beginner",
    region: "US",
  },
  {
    phrase: "Miss the boat",
    meaning: "Miss a chance",
    literalMeaning:
      "He waves at a tiny toy boat floating away in a puddle.",
    exampleSentence: "If you wait too long you will miss the boat.",
    category: "Travel",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Off the beaten track",
    meaning: "In an unusual, quiet place",
    literalMeaning:
      "He steps off a running track and immediately gets lost in a bush.",
    exampleSentence: "The hotel is off the beaten track but lovely.",
    category: "Travel",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "In the same boat",
    meaning: "In the same difficult situation",
    literalMeaning:
      "Six people squeeze into one tiny rowing boat and it sinks slowly.",
    exampleSentence: "We are all in the same boat here.",
    category: "Travel",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Take the wheel",
    meaning: "Take control",
    literalMeaning:
      "He removes the steering wheel and walks away holding it proudly.",
    exampleSentence: "You take the wheel on this project.",
    category: "Travel",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Hit the nail on the head",
    meaning: "Say exactly the right thing",
    literalMeaning:
      "He taps a nail with a giant foam hammer and the nail applauds.",
    exampleSentence: "You hit the nail on the head with that answer.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Once in a blue moon",
    meaning: "Very rarely",
    literalMeaning:
      "He waits outside every night with a paint roller and a ladder.",
    exampleSentence: "We meet once in a blue moon.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Under the table",
    meaning: "Done secretly",
    literalMeaning:
      "He holds an entire meeting while crouched under a small coffee table.",
    exampleSentence: "He was paid under the table.",
    category: "Daily Life",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Hit the hay",
    meaning: "Go to sleep",
    literalMeaning:
      "He drags a hay bale into his bedroom and tucks it in politely.",
    exampleSentence: "I am exhausted, time to hit the hay.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Down to earth",
    meaning: "Practical and friendly",
    literalMeaning:
      "He floats in the air and someone pulls him down by the shoelaces.",
    exampleSentence: "She is famous but very down to earth.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Bite off more than you can chew",
    meaning: "Try to do too much",
    literalMeaning:
      "He takes a comically huge bite of a sandwich and cannot close his mouth.",
    exampleSentence: "He bit off more than he could chew with three jobs.",
    category: "Food",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Burn bridges",
    meaning: "Destroy a relationship permanently",
    literalMeaning:
      "He toasts a tiny model bridge with a birthday candle and looks guilty.",
    exampleSentence: "Do not burn bridges when you leave a job.",
    category: "Relationships",
    difficulty: "Advanced",
    region: "General",
  },
  // --------------------------------------------------------- relationships ---
  {
    phrase: "Break the ice",
    meaning: "Start a conversation with new people",
    literalMeaning:
      "He arrives at a party carrying an ice block and a tiny plastic hammer.",
    exampleSentence: "He told a joke to break the ice.",
    category: "Relationships",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Hit it off",
    meaning: "Become friends quickly",
    literalMeaning:
      "Two people high-five so hard that they both spin around.",
    exampleSentence: "We hit it off right away.",
    category: "Relationships",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Get along",
    meaning: "Have a good relationship",
    literalMeaning:
      "Two friends are stuck together walking in one enormous shared coat.",
    exampleSentence: "My brother and I get along well.",
    category: "Relationships",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Old flame",
    meaning: "A person you used to love",
    literalMeaning:
      "A very old candle with a face waves shyly from a shelf.",
    exampleSentence: "She met an old flame at the party.",
    category: "Relationships",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Tie the knot",
    meaning: "Get married",
    literalMeaning:
      "The couple spends the whole wedding trying to untangle one giant rope.",
    exampleSentence: "They are tying the knot in June.",
    category: "Relationships",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "On thin ice",
    meaning: "In a risky situation",
    literalMeaning:
      "He tiptoes across a puddle wearing four safety helmets.",
    exampleSentence: "You are on thin ice with that attitude.",
    category: "Relationships",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Give the cold shoulder",
    meaning: "Ignore someone on purpose",
    literalMeaning:
      "He offers his friend a shoulder covered in frost and snowflakes.",
    exampleSentence: "She gave him the cold shoulder all evening.",
    category: "Relationships",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Two peas in a pod",
    meaning: "Two people who are very similar",
    literalMeaning:
      "Two friends share one giant pea pod like a sleeping bag.",
    exampleSentence: "Those twins are two peas in a pod.",
    category: "Relationships",
    difficulty: "Intermediate",
    region: "General",
  },
  // ---------------------------------------------------------------- school ---
  {
    phrase: "Ace a test",
    meaning: "Get a very high score",
    literalMeaning:
      "He hands in an exam paper with a playing card ace taped to it.",
    exampleSentence: "She aced her English test.",
    category: "School",
    difficulty: "Beginner",
    region: "US",
  },
  {
    phrase: "Teacher's pet",
    meaning: "The teacher's favourite student",
    literalMeaning:
      "A student sits in a small pet basket beside the teacher's desk.",
    exampleSentence: "Everyone calls him the teacher's pet.",
    category: "School",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Learn by heart",
    meaning: "Memorise completely",
    literalMeaning:
      "He holds a textbook against his chest and waits for it to soak in.",
    exampleSentence: "I learned the poem by heart.",
    category: "School",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Pass with flying colours",
    meaning: "Pass very easily and very well",
    literalMeaning:
      "He walks out of the exam room trailing rainbow flags behind him.",
    exampleSentence: "He passed the exam with flying colours.",
    category: "School",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "Skip class",
    meaning: "Not go to a lesson",
    literalMeaning:
      "He literally skips past the classroom door with a jump rope.",
    exampleSentence: "Do not skip class before the exam.",
    category: "School",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Crack a book",
    meaning: "Open a book to study",
    literalMeaning:
      "He taps a textbook with a spoon like a boiled egg.",
    exampleSentence: "He passed without cracking a book.",
    category: "School",
    difficulty: "Advanced",
    region: "US",
  },
  // --------------------------------------------------------------- weather ---
  {
    phrase: "Storm in a teacup",
    meaning: "A big fuss about something small",
    literalMeaning:
      "A tiny thunderstorm swirls angrily inside a china teacup.",
    exampleSentence: "It was just a storm in a teacup.",
    category: "Weather",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "Chase rainbows",
    meaning: "Try to get something impossible",
    literalMeaning:
      "He sprints after a rainbow with a butterfly net and never gets closer.",
    exampleSentence: "Stop chasing rainbows and make a real plan.",
    category: "Weather",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Steal someone's thunder",
    meaning: "Take attention away from someone",
    literalMeaning:
      "He sneaks off with a cloud under his arm while it rumbles quietly.",
    exampleSentence: "She stole his thunder at the meeting.",
    category: "Weather",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Weather the storm",
    meaning: "Survive a difficult time",
    literalMeaning:
      "He sits calmly reading a book inside a tiny indoor rain cloud.",
    exampleSentence: "The company weathered the storm and survived.",
    category: "Weather",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "A ray of sunshine",
    meaning: "A cheerful person",
    literalMeaning:
      "A single beam of light follows one smiling person around the room.",
    exampleSentence: "My grandmother is a ray of sunshine.",
    category: "Weather",
    difficulty: "Intermediate",
    region: "General",
  },
  // ---------------------------------------------------- American / British ---
  {
    phrase: "Ballpark figure",
    meaning: "A rough estimate",
    literalMeaning:
      "He stands in a baseball field holding a giant number made of foam.",
    exampleSentence: "Give me a ballpark figure for the cost.",
    category: "American English",
    difficulty: "Advanced",
    region: "US",
  },
  {
    phrase: "Monday morning quarterback",
    meaning: "Someone who criticises after the event",
    literalMeaning:
      "He wears full sports gear to the office on a Monday and explains everything.",
    exampleSentence: "Do not be a Monday morning quarterback.",
    category: "American English",
    difficulty: "Advanced",
    region: "US",
  },
  {
    phrase: "Ride shotgun",
    meaning: "Sit in the front passenger seat",
    literalMeaning:
      "He climbs into the car holding a water pistol and a serious expression.",
    exampleSentence: "I call riding shotgun!",
    category: "American English",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Bob's your uncle",
    meaning: "And there it is; it is that simple",
    literalMeaning:
      "A man named Bob appears in the doorway and waves cheerfully.",
    exampleSentence: "Press the button and Bob's your uncle.",
    category: "British English",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "Chuffed to bits",
    meaning: "Very pleased",
    literalMeaning:
      "He is so happy that he gently falls apart into smiling pieces.",
    exampleSentence: "I am chuffed to bits with my results.",
    category: "British English",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "Take the biscuit",
    meaning: "Be the most surprising or annoying thing",
    literalMeaning:
      "He removes one biscuit from a plate and everyone gasps dramatically.",
    exampleSentence: "That excuse really takes the biscuit.",
    category: "British English",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "Throw a spanner in the works",
    meaning: "Spoil a plan",
    literalMeaning:
      "He gently places a spanner into a cardboard machine, which sighs and stops.",
    exampleSentence: "The rain threw a spanner in the works.",
    category: "British English",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "Fair dinkum",
    meaning: "Genuine; true",
    literalMeaning:
      "He inspects his friend with a magnifying glass and a certificate stamp.",
    exampleSentence: "Is that story fair dinkum?",
    category: "Funny Expressions",
    difficulty: "Advanced",
    region: "Australia",
  },
  {
    phrase: "No worries",
    meaning: "That is fine; no problem",
    literalMeaning:
      "He puts all his worries into a box and posts it away happily.",
    exampleSentence: "No worries, I can help you.",
    category: "Funny Expressions",
    difficulty: "Beginner",
    region: "Australia",
  },
  // ---------------------------------------------------- funny expressions ----
  {
    phrase: "Barking up the wrong tree",
    meaning: "Looking in the wrong place",
    literalMeaning:
      "He barks politely at a lamp post while a dog watches, embarrassed.",
    exampleSentence: "If you think I took it, you are barking up the wrong tree.",
    category: "Funny Expressions",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Beat around the bush",
    meaning: "Avoid saying the main point",
    literalMeaning:
      "He walks in slow circles around a small potted bush for a full minute.",
    exampleSentence: "Stop beating around the bush and tell me.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Hit the ceiling",
    meaning: "Become very angry",
    literalMeaning:
      "He gets upset and floats straight up until his head touches the ceiling.",
    exampleSentence: "Dad hit the ceiling when he saw the mess.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Jump on the bandwagon",
    meaning: "Join something because it is popular",
    literalMeaning:
      "He leaps onto a tiny wagon already packed with a marching band.",
    exampleSentence: "Everyone jumped on the bandwagon after the team won.",
    category: "Funny Expressions",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Kick the bucket list",
    meaning: "Finish the things you wanted to do in life",
    literalMeaning:
      "He gently taps a bucket with his shoe and then ticks off a paper list.",
    exampleSentence: "Skydiving was on my bucket list.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Sit on the fence",
    meaning: "Refuse to choose a side",
    literalMeaning:
      "He balances on a garden fence with a picnic basket, refusing to come down.",
    exampleSentence: "He always sits on the fence in arguments.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Throw in the towel",
    meaning: "Give up",
    literalMeaning:
      "He tosses a bath towel into the room and it lands on someone's head.",
    exampleSentence: "Do not throw in the towel yet.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Up in the air",
    meaning: "Not decided yet",
    literalMeaning:
      "The weekend plan is written on a paper plane circling the ceiling.",
    exampleSentence: "Our holiday plans are still up in the air.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Blow off steam",
    meaning: "Release stress or anger",
    literalMeaning:
      "Cartoon steam whistles out of his ears like a kettle and he feels better.",
    exampleSentence: "He went for a run to blow off steam.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Read between the lines",
    meaning: "Understand the hidden meaning",
    literalMeaning:
      "He puts his eye right between two lines of text and squints hard.",
    exampleSentence: "Read between the lines of her message.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Cut corners",
    meaning: "Do something cheaply or quickly, with worse quality",
    literalMeaning:
      "He snips the corners off a square table so it becomes a wobbly circle.",
    exampleSentence: "Do not cut corners on safety.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Hands are tied",
    meaning: "Unable to help because of rules",
    literalMeaning:
      "His hands are wrapped in soft ribbon and he shrugs apologetically.",
    exampleSentence: "I would help, but my hands are tied.",
    category: "Work",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Play it by ear",
    meaning: "Decide as you go, without a plan",
    literalMeaning:
      "He tries to play a piano using only his ear pressed to the keys.",
    exampleSentence: "Let us play it by ear and see what happens.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Sleep on it",
    meaning: "Take time before deciding",
    literalMeaning:
      "He puts the contract on his pillow and lies down on top of it.",
    exampleSentence: "I will sleep on it and answer tomorrow.",
    category: "Daily Life",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Speak of the devil",
    meaning: "Said when the person you were talking about appears",
    literalMeaning:
      "A friend in a red party hat pops through the door holding balloons.",
    exampleSentence: "Speak of the devil, here she is!",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "The best of both worlds",
    meaning: "All the advantages of two things",
    literalMeaning:
      "He stands with one foot on a beach and one foot in a snowy field.",
    exampleSentence: "Working from home gives me the best of both worlds.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Time flies",
    meaning: "Time passes very quickly",
    literalMeaning:
      "A clock grows little wings and flaps away out of the window.",
    exampleSentence: "Time flies when you are having fun.",
    category: "Daily Life",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Catch some Z's",
    meaning: "Get some sleep",
    literalMeaning:
      "He runs around with a net catching floating letter Z's out of the air.",
    exampleSentence: "I need to catch some Z's before the flight.",
    category: "American English",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Green thumb",
    meaning: "A talent for growing plants",
    literalMeaning:
      "His thumb is bright green and a tiny leaf sprouts from the tip.",
    exampleSentence: "My mother has a green thumb.",
    category: "American English",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Couch potato",
    meaning: "Someone who watches TV all day",
    literalMeaning:
      "A friendly cartoon potato lounges on the sofa holding the remote.",
    exampleSentence: "Do not be a couch potato all weekend.",
    category: "Daily Life",
    difficulty: "Beginner",
    region: "US",
  },
  {
    phrase: "Smell a rat",
    meaning: "Suspect something is wrong",
    literalMeaning:
      "He sniffs the air and a cartoon rat in a tiny disguise sneaks past.",
    exampleSentence: "Something is strange here. I smell a rat.",
    category: "Animals",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Hit the jackpot",
    meaning: "Get very lucky",
    literalMeaning:
      "He taps a vending machine and it buries him in soft foam coins.",
    exampleSentence: "We hit the jackpot with this apartment.",
    category: "Money",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Put your foot in your mouth",
    meaning: "Say something embarrassing by accident",
    literalMeaning:
      "He tries to fit his own sneaker into his mouth and gives up.",
    exampleSentence: "I put my foot in my mouth at dinner.",
    category: "Body",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Blow your own trumpet",
    meaning: "Praise yourself too much",
    literalMeaning:
      "He plays a trumpet that has a small mirror attached, facing himself.",
    exampleSentence: "He loves blowing his own trumpet.",
    category: "British English",
    difficulty: "Advanced",
    region: "UK",
  },
  {
    phrase: "A piece of the action",
    meaning: "A share of something exciting",
    literalMeaning:
      "He arrives with scissors and asks to cut a slice out of a movie scene.",
    exampleSentence: "Everyone wants a piece of the action.",
    category: "Money",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Get out of hand",
    meaning: "Become impossible to control",
    literalMeaning:
      "A small party balloon escapes his hand and grows to fill the whole room.",
    exampleSentence: "The party got out of hand.",
    category: "Daily Life",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Long story short",
    meaning: "To summarise quickly",
    literalMeaning:
      "He folds a very long scroll into a tiny square and hands it over.",
    exampleSentence: "Long story short, we missed the train.",
    category: "Daily Life",
    difficulty: "Beginner",
    region: "General",
  },
  {
    phrase: "Wrap your head around it",
    meaning: "Finally understand something difficult",
    literalMeaning:
      "He wraps his head around a globe like a scarf and nods thoughtfully.",
    exampleSentence: "I cannot wrap my head around this maths problem.",
    category: "School",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Hang in there",
    meaning: "Do not give up",
    literalMeaning:
      "He dangles from a tree branch by one hand, smiling bravely at the camera.",
    exampleSentence: "Hang in there, the exam is almost over.",
    category: "Daily Life",
    difficulty: "Beginner",
    region: "US",
  },
  {
    phrase: "Face the music",
    meaning: "Accept the consequences",
    literalMeaning:
      "He turns to face a small orchestra that is glaring at him.",
    exampleSentence: "He broke the window and had to face the music.",
    category: "Funny Expressions",
    difficulty: "Advanced",
    region: "General",
  },
  {
    phrase: "Pull yourself together",
    meaning: "Calm down and control yourself",
    literalMeaning:
      "He reassembles himself from a pile of cartoon puzzle pieces.",
    exampleSentence: "Pull yourself together, it is only a game.",
    category: "Funny Expressions",
    difficulty: "Intermediate",
    region: "General",
  },
  {
    phrase: "Shake a leg",
    meaning: "Hurry up",
    literalMeaning:
      "He waggles one leg energetically while standing completely still.",
    exampleSentence: "Shake a leg, the bus is coming!",
    category: "Body",
    difficulty: "Intermediate",
    region: "US",
  },
  {
    phrase: "Zip your lip",
    meaning: "Stay quiet",
    literalMeaning:
      "He pulls a cartoon zipper across his mouth and pockets the zip.",
    exampleSentence: "Zip your lip, it is a surprise!",
    category: "Body",
    difficulty: "Beginner",
    region: "US",
  },
];
