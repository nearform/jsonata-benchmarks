'use strict';

const jsonata = require('jsonata');
const fetch = require('node-fetch');
const {isEqual} = require('lodash');
const {inspect} = require('util');
const Benchmark = require('benchmark');

async function getLaureates() {
  const response = await fetch(
    'http://api.nobelprize.org/2.0/laureates?nobelPrizeYear=2000&yearTo=2005&limit=100'
  );
  return response.json();
}

async function getPrizes() {
  const response = await fetch(
    'http://api.nobelprize.org/2.0/nobelPrizes?nobelPrizeYear=2000&yearTo=2005&limit=100'
  );
  return response.json();
}

const jsonataSimple = jsonata('laureates.knownName.en');

const jsonataComplex = jsonata(`
laureates.{
  "name": knownName.en ? knownName.en : orgName.en,
  "gender": gender,
  "prizes": nobelPrizes.categoryFullName.en[]
}
`);

const jsonataComplexWithSort = jsonata(`
laureates.{
  "name": knownName.en ? knownName.en : orgName.en,
  "gender": gender,
  "prizes": nobelPrizes.categoryFullName.en[]
}^(name)
`);

const jsonataJoin = jsonata(`
(prizes.nobelPrizes)@$p.(laureates.laureates)@$l[$l.id in $p.laureates.id].{
  "name": $l.knownName.en,
  "gender": $l.gender,
  "prize": $p.categoryFullName.en
}
`);

const jsonataAggregates = jsonata(`(
$sp := nobelPrizes.{"count": $count(laureates)}.count;

{
  "count": $count($sp),
  "sum": $sum($sp),
  "average": $average($sp),
  "min": $min($sp),
  "max": $max($sp)
};
)`);

function jsSimple(input) {
  return input.laureates
    .map((laureate) => laureate?.knownName?.en)
    .filter((name) => name);
}

function jsComplex(input) {
  return input?.laureates.map((l) => ({
    name: l?.knownName?.en || l?.orgName.en,
    gender: l?.gender,
    prizes: l?.nobelPrizes.map((p) => p?.categoryFullName?.en)
  }));
}

function jsComplexWithSort(input) {
  return input?.laureates
    .map((l) => ({
      name: l?.knownName?.en || l?.orgName.en,
      gender: l?.gender,
      prizes: l?.nobelPrizes.map((p) => p?.categoryFullName?.en)
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function jsJoin({laureates, prizes}) {
  // Map over each prize (flatMap automatically removes the resulting nesting)
  return prizes.nobelPrizes.flatMap((prize) =>
    // Filter all laureates who have an id associated with the prize.
    // This is complex because each prize can have multiple laureates.
    laureates.laureates
      .filter((laureate) =>
        prize.laureates
          .map((prizeLaureate) => prizeLaureate.id)
          .includes(laureate.id)
      )
      // Map each laureate and prize to the new data structure
      .map((laureate) => ({
        name: laureate?.knownName?.en,
        gender: laureate?.gender,
        prize: prize?.categoryFullName?.en
      }))
  );
}

function jsAggregates(input) {
  const prizeLaureates = input.nobelPrizes.map(
    (prize) => prize.laureates.length
  );
  const sum = prizeLaureates.reduce((previous, cur) => previous + cur, 0);
  return {
    count: prizeLaureates.length,
    sum,
    average: sum / prizeLaureates.length,
    min: Math.min(...prizeLaureates),
    max: Math.max(...prizeLaureates)
  };
}

const results = [];
async function runTest(name, bench1, bench2) {
  const test1 = bench1();
  const test2 = bench2();

  if (
    !isEqual(
      // JSONata pollutes arrays, see: https://github.com/jsonata-js/jsonata/issues/296
      // Stringify and parse to remove the pollution.
      JSON.parse(JSON.stringify(test1)),
      JSON.parse(JSON.stringify(test2))
    )
  ) {
    console.log(`${name} benchmark 1 output:`);
    console.log(inspect(test1, {colors: true, depth: 8}));
    console.log(`${name} benchmark 2 output:`);
    console.log(inspect(test2, {colors: true, depth: 2}));
    throw new Error(
      'Invalid Test, the benchmarks do not produce the same results'
    );
  }

  return new Promise((resolve) => {
    // Add tests
    new Benchmark.Suite()
      .add(`${name} benchmark 1`, bench1)
      .add(`${name} benchmark 2`, bench2)
      // Add listeners
      .on('cycle', function (event) {
        console.log(String(event.target));
      })
      .on('complete', function () {
        console.log('Fastest is ' + this.filter('fastest').map('name'));
        results.push({
          name,
          cyclesPerSec1: Math.round(this[0].hz),
          cyclesPerSec2: Math.round(this[1].hz),
          oneOverZero: Math.round(this[0].hz / this[1].hz),
          percentAsFast: Math.round((this[1].hz / this[0].hz) * 100),
          percentSlower: Math.round((1 - this[1].hz / this[0].hz) * 100)
        });
        resolve();
      })
      // Run async
      .run({async: true});
  });
}

async function run() {
  const laureates = await getLaureates();
  const prizes = await getPrizes();

  console.log(inspect(laureates.laureates[0], {colors: true, depth: 5}));
  console.log(inspect(prizes.nobelPrizes[0], {colors: true, depth: 5}));

  await runTest(
    'simple mapping',
    () => jsSimple(laureates),
    () => jsonataSimple.evaluate(laureates)
  );
  await runTest(
    'complex mapping',
    () => jsComplex(laureates),
    () => jsonataComplex.evaluate(laureates)
  );
  await runTest(
    'complex join',
    () => jsJoin({laureates, prizes}),
    () => jsonataJoin.evaluate({laureates, prizes})
  );
  await runTest(
    'complex mapping with sort',
    () => jsComplexWithSort(laureates),
    () => jsonataComplexWithSort.evaluate(laureates)
  );
  await runTest(
    'complex join',
    () => jsJoin({laureates, prizes}),
    () => jsonataJoin.evaluate({laureates, prizes})
  );
  await runTest(
    'aggregates',
    () => jsAggregates(prizes),
    () => jsonataAggregates.evaluate(prizes)
  );

  console.log('RESULTS:', results);
}

run();
