import * as dotenv from "dotenv";
import Joi from "joi";
dotenv.config();

export const isLocal = process.env.NODE_ENV === "local";

const envVarsSchema = Joi.object()
  .keys({
    PORT: Joi.number().default(50051),

    // POSTGRES_URL: Joi.string().required(),

    TWITTER_CONSUMER_KEY: Joi.string(),
    TWITTER_CONSUMER_SECRET: Joi.string(),

    OPENAI_API_KEY: Joi.string(),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: "key" } })
  .validate(process.env);

if (error != null) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const env = {
  port: envVars.PORT,

  // postgres: {
  //   url: envVars.POSTGRES_URL,
  // },

  twitter: {
    consumerKey: envVars.TWITTER_CONSUMER_KEY,
    consumerSecret: envVars.TWITTER_CONSUMER_SECRET,
  },
  openai: {
    apiKey: envVars.OPENAI_API_KEY,
  },
};
