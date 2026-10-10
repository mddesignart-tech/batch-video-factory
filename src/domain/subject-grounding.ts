/**
 * SUBJECT GROUNDING (QĐ-131 G10) - deterministic rules, no vision. Pure.
 *
 * How big a cut-out stands, whether it touches the ground (contact shadow) or
 * flies (none), decided from what the layer IS (entity type) and what it is
 * CALLED (its label, English or Vietnamese). The user's own size / standing
 * line in VỊ TRÍ TRONG KHUNG always wins over these defaults.
 */

import type { EntityType } from "./scene-plan";

export type SubjectKind = "PERSON" | "PRODUCT" | "ANIMAL" | "OBJECT";

export function subjectKind(entityType: EntityType | string | undefined): SubjectKind {
  if (entityType === "CHARACTER" || entityType === "PERSON") return "PERSON";
  if (entityType === "PRODUCT") return "PRODUCT";
  if (entityType === "ANIMAL") return "ANIMAL";
  return "OBJECT";
}

const word = (en: string, vi: string) => new RegExp(`(?<!\\p{L})(?:${en}|${vi})(?!\\p{L})`, "iu");

/** Animal size classes, as a share of a standing person's box. */
const ANIMAL_SIZES: { re: RegExp; scale: number }[] = [
  // Tiny: a bird, a butterfly, a mouse - a small spot in a scene, not a poster.
  { re: word("birds?|sparrows?|bluebirds?|robins?|finch(?:es)?|butterfl(?:y|ies)|bees?|mouse|mice|hamsters?|frogs?|squirrels?|parrots?", "chim|bướm|ong|chuột|ếch|sóc|vẹt"), scale: 0.2 },
  // Medium: a cat, a dog, a rabbit, poultry.
  { re: word("cats?|kittens?|dogs?|pupp(?:y|ies)|rabbits?|bunn(?:y|ies)|foxe?s?|chickens?|hens?|ducks?|geese|goose|owls?|monkeys?", "mèo|chó|cún|thỏ|cáo|gà|vịt|ngỗng|cú|khỉ"), scale: 0.4 },
  // Large: a horse, a cow, a deer, a bear.
  { re: word("horses?|cows?|deer|bears?|lions?|tigers?|elephants?|camels?|giraffes?|zebras?", "ngựa|bò|hươu|nai|gấu|sư tử|hổ|voi|lạc đà|hươu cao cổ|ngựa vằn"), scale: 0.85 },
];

/** Default size of an animal with no size of its own (unknown kind = medium-small). */
export function animalScale(label: string): number {
  return ANIMAL_SIZES.find((a) => a.re.test(label))?.scale ?? 0.4;
}

const AIRBORNE = word("fly(?:ing)?|flies|flight|soar(?:ing|s)?|glid(?:e|ing)|hover(?:ing|s)?|in the air|in the sky", "bay|đang bay|lượn|bay lượn|trên trời|giữa không trung");

/** A flying subject casts no contact shadow and is not stood on the ground. */
export function isAirborne(text: string, flag?: boolean): boolean {
  if (flag !== undefined) return flag;
  return AIRBORNE.test(text);
}

/** Default size within the layout box, by kind (undefined = fill the box: a standing person). */
export function defaultScale(kind: SubjectKind, label: string): number | undefined {
  if (kind === "ANIMAL") return animalScale(label);
  // Alone or beside a presenter, a product must read clearly (G10: 0.4 beside a presenter was too small to see).
  if (kind === "PRODUCT") return 0.6;
  return undefined;
}
