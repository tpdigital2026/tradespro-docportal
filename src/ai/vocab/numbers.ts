/** Spoken numbers (and ordinals used as counts or durations) mapped to the figure they stand for. Data only. */
export const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', dozen: '12', half: '0.5', double: '2', triple: '3', twice: '2', single: '1',
  // Ordinals count too: "second year" is a duration of two years. (first is left out: "first fix" is ordinary trade talk.) "Second year" therefore reads as the number 2 plus the word year.
  second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
};
