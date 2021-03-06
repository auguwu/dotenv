const UnionTypeReader = require('./readers/UnionTypeReader');
const ArrayTypeReader = require('./readers/ArrayTypeReader');
const { Collection } = require('@augu/collections');
const readers = require('./readers');
const fs = require('fs');

const IniKeyVal = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/;
const Newline = /\\n/g;
const NewlineMatch = /\n|\r|\r\n/;

/**
 * Gets an option if it exists in `options` or uses the default value
 * @template T The options object
 * @param {T} options The options to use
 * @param {keyof T} prop The property
 * @param {T[keyof T]} defaultValue The default value
 */
function getOption(options, prop, defaultValue) {
  if (options === undefined) return defaultValue;
  else if (options.hasOwnProperty(prop)) return options[prop];
  else return defaultValue;
}

/**
 * Returns if `obj` is empty
 */
function isEmptyObject(obj) {
  return Object.keys(obj).length < 1;
}

const sep = process.platform === 'win32' ? '\\' : '/';

module.exports = class Parser {
  /**
   * Creates a new `Parser`
   * @param {ParserOptions} options The options
   */
  constructor(options) {
    /**
     * If we should populate this parser to `process.env`
     * @type {boolean}
     */
    this.populate = getOption(options, 'populate', true);

    /**
     * The delimiter to split an string to an Array
     * @type {string}
     */
    this.delimiter = getOption(options, 'delimiter', ', ');

    /**
     * The schema to abide (if provided)
     * @type {Schema | null}
     */
    this.schema = getOption(options, 'schema', {});

    /**
     * The list of type readers to use
     * @type {Collection<string, import('./TypeReader')>}
     */
    this.readers = new Collection();

    /**
     * The file location
     * @type {string}
     */
    this.file = getOption(options, 'file', `${process.cwd()}${sep}.env`);

    // Add the default readers
    this.addDefaultReaders(options);
  }

  /**
   * Adds the readers
   * @param {ParserOptions} options The options
   */
  addDefaultReaders(options) {
    this.readers.set('array', new ArrayTypeReader(this.delimiter));

    for (const TypeReader of Object.values(readers)) {
      const reader = new TypeReader();
      this.readers.set(reader.id, reader);
    }

    /** @type {(import('./TypeReader'))[]} */
    const custom = getOption(options, 'readers', []);

    if (custom.length) {
      for (let i = 0; i < custom.length; i++) {
        const TypeReader = custom[i];
        const instance = new TypeReader();

        this.readers.set(instance.id, instance);
      }
    }
  }

  /**
   * Gets a reader by it's `id`
   * @param {string} id The type reader's ID
   */
  getReader(id) {
    if (!id) return undefined;
    if (!id.includes('|')) return this.readers.get(id);

    let type = this.readers.get(id);
    if (type) return type;

    type = new UnionTypeReader(this, id);
    this.readers.set(id, type);

    return type;
  }

  /**
   * Parses the result and returns the object itself
   */
  parseResult() {
    if (!fs.existsSync(this.file)) throw new SyntaxError(`File "${this.file}" doesn't exist`);

    const parsed = {};
    const env = fs.readFileSync(this.file, { encoding: 'utf8' });
    const ast = env.split(NewlineMatch);

    for (const key of ast) {
      const keyVal = key.match(IniKeyVal);

      if (keyVal !== null) {
        const key = keyVal[1];
        let value = (keyVal[2] || '');
        const schema = isEmptyObject(this.schema) ? null : this.schema;

        const isCommented = value[0] === '#' || value[0] === '# ';
        const isQuoted = value[0] === '"' && value[value.length - 1] === '"';
        const isSingleQuoted = value[0] === "'" && value[value.length - 1] === "'"; // eslint-disable-line quotes

        if (isCommented) continue;
        if (isQuoted || isSingleQuoted) {
          value = value.substring(1, value.length - 1);
          if (isQuoted) value = value.replace(Newline, NewlineMatch);
        } else {
          value = value.trim();
        }

        if (schema === null) {
          parsed[key] = value;
        } else {
          if (!schema.hasOwnProperty(key)) continue;
          else {
            const val = schema[key];
            if (typeof val === 'string') {
              const reader = this.getReader(val);
              if (reader === undefined) throw new TypeError(`Reader "${val}" doesn't exist`);

              if (!reader.validate(value)) {
                continue;
              } else {
                parsed[key] = reader.parse(value);
              }
            } else {
              const reader = this.getReader(val.type);
              if (reader === undefined) throw new TypeError(`Reader "${val.type}" doesn't exist`);

              if (!reader.validate(value)) {
                parsed[key] = getOption(val, 'default', null);
              } else {
                if (val.hasOwnProperty('oneOf') && !val.oneOf.includes(value)) throw new TypeError(`Value "${value}" doesn't abide by the options: ${val.oneOf.join(', ')}`);
                if (val.type === 'int') {
                  let min = undefined;
                  let max = undefined;

                  if (val.hasOwnProperty('min')) min = val.min;
                  if (val.hasOwnProperty('max')) max = val.max;

                  const entity = reader.parse(value);
                  if (min !== undefined && value < min) throw new TypeError(`Value "${entity}" is less than the minimum value ("${min}")`);
                  if (max !== undefined && value > max) throw new TypeError(`Value "${entity}" is more than the maximum value ("${max}")`);
                }

                if (val.type === 'string') {
                  let min = undefined;
                  let max = undefined;

                  if (val.hasOwnProperty('min')) min = val.min;
                  if (val.hasOwnProperty('max')) max = val.max;

                  const entity = reader.parse(value);
                  if (min !== undefined && value.length < min) throw new TypeError(`Value "${entity}" is less than the minimum value ("${min}")`);
                  if (max !== undefined && value.length > max) throw new TypeError(`Value "${entity}" is more than the maximum value ("${max}")`);
                }

                parsed[key] = reader.parse(value);
              }
            }
          }
        }
      }
    }

    return parsed;
  }

  /**
   * Populates `process.env` with the parsed values
   */
  populateToEnv() {
    if (!this.populate) throw new TypeError('options.populate is false (Parser#populateToEnv is not avaliable)');

    const parsed = this.parseResult();
    for (const [key, value] of Object.entries(parsed)) {
      if (!process.env.hasOwnProperty(key)) process.env[key] = value;
    }
  }
};

/**
 * @typedef {object} ParserOptions
 * @prop {(import('./TypeReader'))[]} [readers=[]] The custom type readers to use
 * @prop {string} [delimiter=', '] A custom delimiter for the Array type reader (default: `, `)
 * @prop {boolean} [populate=true] If we should populate this Parser to `process.env`
 * @prop {Schema} [schema] The schema to follow by
 * @prop {string} [file='.env'] The file to follow by
 *
 * @typedef {{ [x: string]: string | SchemaOptions; }} Schema
 * @typedef {object} SchemaOptions
 * @prop {any} [default] Uses this if the value doesn't exist
 * @prop {any[]} [oneOf] If the value is an array (string splitted by `, `), it'll have to abide by these options or it'll error
 * @prop {number} [min] The minimum amount to use (only used in the `number` and `string` type reader)
 * @prop {number} [max] The maxmimum amount to use (only used in the `number` and `string` type reader)
 * @prop {string} type The type of the schema
 */
