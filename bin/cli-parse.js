const program = require('commander')

const fp = require('../src')
const db = require('../shared/db')
const helpers = require('../shared/helpers')
const logger = require('../shared/logger')
const prompts = require('../shared/prompts')
const routes = require('../shared/routes')

program
  .option('-w, --website <airline>', 'Limit parsing to the specified airline (IATA 2-letter code)')
  .option('-v, --verbose', 'Verbose logging')
  .option('-y, --yes', 'Automatically confirm deletion of failed requests')
  .option('--force', 'Re-parse requests, even if they have already been parsed previously')
  .parse(process.argv)

const main = async (args) => {
  const { verbose, yes, force } = args
  let numRequests = 0
  let numAwards = 0

  const dbPool = await db.createPool();

  try {
    // Iterate over search requests
    logger.info('Parsing search requests...')
    const failed = []
    for (const row of await db.getRequestsWithoutAwards(dbPool, args.website, force)) {
      // First delete all awards associated with this request
      const oldAwards = await db.getRequest(dbPool, row.id);
      helpers.cleanupAwards(dbPool, oldAwards)

      // Create a Results instance from the row
      const results = helpers.loadRequest(row)

      // Process the request
      numRequests++
      const { awards } = results

      // Print the route
      if (verbose || !results.ok) {
        routes.print(row)
      }

      // Handle errors by cleaning up the request
      if (!results.ok) {
        logger.error(results.error)
        failed.push(row)
        continue
      }

      // Print the award fares for this route
      if (verbose) {
        for (const award of awards) {
          const { flight, fare, mileageCost } = award
          const { fromCity, toCity, date } = flight
          const segments = flight.segments.map(x => x.flight).join('-')
          logger.info(`    [${fromCity} -> ${toCity}] - ${date} ${segments} (${mileageCost} Miles): ${fare.code}${award.waitlisted ? '@' : '+'}`)
        }
      }

      // Update the database
      const placeholders = helpers.createPlaceholders(results, { cabins: Object.values(fp.cabins) })
      await helpers.saveAwards(dbPool, row.id, awards, placeholders)
      numAwards += awards.length
    }

    if (failed.length > 0) {
      if (yes || prompts.askYesNo(`${failed.length} failed requests will be purged from the database. Do you want to continue?`)) {
        logger.info('Cleaning up stored files and database entries...')
        for (const row of failed) {
          await helpers.cleanupRequest(dbPool, row)
        }
      }
    }

    logger.success(`Search requests processed: ${numRequests}`)
    logger.success(`Total awards found: ${numAwards}`)
  } catch (err) {
    logger.error(err.message)
    console.error(err)
    process.exit(1)
  } finally {
    db.close()
  }
}

// Validate arguments
if (!fp.supported(program.website)) {
  logger.error(`Unsupported airline website to parse: ${program.website}`)
  process.exit(1)
}
main(program)
