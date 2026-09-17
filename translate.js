/* Copyright 2013 - 2024 Waiterio LLC */
import dictionaries from './dictionaries.js'

export default function translate(key, language) {
  language ||= 'en'

  let value = dictionaries[language]?.[key] || dictionaries.en?.[key] || key

  return value
}
