declare module "iterative-permutation" {
  class Permutator<T> {
    constructor(value: T[]);
    hasNext(): boolean;
    next(): T[];
  }
  export default Permutator;
}
