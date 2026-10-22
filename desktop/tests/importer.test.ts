import { describe, expect, it } from 'vitest'
import { ImportError, parseImportContent } from '../src/main/importer'

describe('import CSV', () => {
  it('lit un fichier avec en-tête et champs entre guillemets', () => {
    const csv = [
      'label,password',
      '"GitHub, pro","Kj#9mLpQ2$vXn8!wR#"',
      'Banque,"Abc,def"',
      '',
    ].join('\n')

    expect(parseImportContent(csv, 'export.csv')).toEqual([
      { label: 'GitHub, pro', password: 'Kj#9mLpQ2$vXn8!wR#' },
      { label: 'Banque', password: 'Abc,def' },
    ])
  })

  it('gère les points-virgules et les en-têtes accentués', () => {
    const csv = ['mot clé;mot de passe', 'Café ☕;xovuk-8Nevqe-hidwuf', 'Impôts;Abcdef1!'].join('\n')

    expect(parseImportContent(csv, 'export.csv')).toEqual([
      { label: 'Café ☕', password: 'xovuk-8Nevqe-hidwuf' },
      { label: 'Impôts', password: 'Abcdef1!' },
    ])
  })

  it('gère les tabulations et les colonnes dans un autre ordre', () => {
    const tsv = ['url\tusername\tpassword', 'https://github.com\tmoi\tAbcdef1!'].join('\n')

    expect(parseImportContent(tsv, 'export.tsv')).toEqual([
      { label: 'https://github.com', password: 'Abcdef1!' },
    ])
  })

  it('accepte un fichier sans en-tête à deux colonnes', () => {
    const csv = ['GitHub,Kj#9mLpQ2$vXn8!wR#', 'Banque,Abcdef1!'].join('\n')

    expect(parseImportContent(csv, 'export.csv')).toEqual([
      { label: 'GitHub', password: 'Kj#9mLpQ2$vXn8!wR#' },
      { label: 'Banque', password: 'Abcdef1!' },
    ])
  })

  it('ignore les lignes incomplètes et les doublons', () => {
    const csv = [
      'label,password',
      'GitHub,Abcdef1!',
      'GitHub,Abcdef1!',
      'SansMotDePasse,',
      ',Abcdef1!',
      'Banque,"ligne',
      'sur deux"',
    ].join('\n')

    expect(parseImportContent(csv, 'export.csv')).toEqual([
      { label: 'GitHub', password: 'Abcdef1!' },
      { label: 'Banque', password: 'ligne\nsur deux' },
    ])
  })

  it('refuse un fichier sans colonne de mot de passe', () => {
    expect(() => parseImportContent('label,notes\nGitHub,test', 'export.csv')).toThrow(ImportError)
    expect(() => parseImportContent('label,notes\nGitHub,test', 'export.csv')).toThrow(
      /mot de passe introuvable/i,
    )
  })

  it('refuse un fichier vide', () => {
    expect(() => parseImportContent('   \n', 'export.csv')).toThrow(/vide/i)
  })
})

describe('import JSON', () => {
  it('lit un tableau avec des alias de colonnes', () => {
    const json = JSON.stringify([
      { name: 'GitHub', password: 'Kj#9mLpQ2$vXn8!wR#' },
      { site: 'Banque', secret: 'Abcdef1!' },
    ])

    expect(parseImportContent(json, 'export.json')).toEqual([
      { label: 'GitHub', password: 'Kj#9mLpQ2$vXn8!wR#' },
      { label: 'Banque', password: 'Abcdef1!' },
    ])
  })

  it('lit un objet { entries: [...] }', () => {
    const json = JSON.stringify({ entries: [{ label: 'Impôts', password: 'Abcdef1!' }] })

    expect(parseImportContent(json, 'vault.json')).toEqual([
      { label: 'Impôts', password: 'Abcdef1!' },
    ])
  })

  it('lit un export Bitwarden simplifié', () => {
    const json = JSON.stringify({
      items: [{ name: 'GitHub', login: { username: 'moi', password: 'Abcdef1!' } }],
    })

    expect(parseImportContent(json, 'bitwarden.json')).toEqual([
      { label: 'GitHub', password: 'Abcdef1!' },
    ])
  })

  it('détecte le JSON sans tenir compte de l’extension', () => {
    const json = JSON.stringify([{ label: 'GitHub', password: 'Abcdef1!' }])
    expect(parseImportContent(json, 'export.txt')).toHaveLength(1)
  })

  it('refuse un JSON invalide ou non reconnu', () => {
    expect(() => parseImportContent('{', 'export.json')).toThrow(/JSON invalide/i)
    expect(() => parseImportContent('{"foo": 1}', 'export.json')).toThrow(/non reconnu/i)
  })
})
