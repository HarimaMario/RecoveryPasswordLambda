import { createRequire } from 'module';
const require = createRequire(import.meta.url);
var AWS = require('aws-sdk');
AWS.config.update({region:'us-east-1'});
var mysql = require('mysql');
var momentTZ = require('moment-timezone');
var SNS = new AWS.SNS();
var SSM = new AWS.SSM();

export const handler = async (event) => {
  try {
    let connectionInformation = await parseParameterFromSSM();
    var con = mysql.createConnection({
      host: connectionInformation.host,
      user: connectionInformation.user,
      password: connectionInformation.password,
      database: connectionInformation.database
    });
  

    const today = momentTZ().tz("America/Mexico_City").format("YYYY-MM-DD HH:mm:ss");
    const effective_date = momentTZ().tz("America/Mexico_City").add(2, "hours").format();
    const recoveryCode = Math.floor(Math.random() * 89999) + 10000;
    const phoneNumber = event.queryStringParameters.phoneNumber;
    const email = event.queryStringParameters.email;
    const cooldown = 5;
    const emailWithoutInjection = mysql.escape(email, true).replaceAll("'", "");
    const phonelWithoutInjection = isNaN(phoneNumber) ? '' : phoneNumber ;

    var params = {
      Message: "Tu contraseña de DLM está siendo recuperada \nTu código de DLM es: " + recoveryCode,
      PhoneNumber: "+52" + phoneNumber,
    };

    var sqlSelect = 'select * from forgot_pass_codes WHERE email = ?';
    return new Promise(function (resolve, reject) {

      con.query(sqlSelect, [emailWithoutInjection], function async(err, result) {
        if (err) {
          console.log("Error con SQL");
          reject({
            statusCode: 400,
            body: JSON.stringify({
              error: err
            })
          });
        }

        else {
          resolve({ result })
        }
      });
    }).then(function (response) {

      //update
      if (response.result.length > 0) {

        const sqlUpdate = "update forgot_pass_codes set " +
                          "code = '" + recoveryCode + "', " +
                          "phone_number = '" + phonelWithoutInjection + "', " +
                          "efective_date = '" + effective_date + "', " +
                          "updated_at = '" + today + "' " +
                          "where email = '" + emailWithoutInjection + "'";

        console.log("SQLUpdate", sqlUpdate);
        return new Promise(function (resolve, reject) {
          con.query(sqlUpdate, function async(errU, resultU) {
            //error
            if (errU) {
              reject({
                statusCode: 400,
                body: JSON.stringify({
                  error: "Error al actualizar registro",
                  message: errU
                })
              });
            }

            //exito
            else {
              if (resultU.affectedRows > 0) {
                resolve({
                  statusCode: 200,
                  body: JSON.stringify({
                    recoveryCode: recoveryCode,
                    cooldown: cooldown,

                  })
                });
              }

              else {
                reject({
                  statusCode: 400,
                  body: JSON.stringify({
                    error: "Error al actualizar registro",
                    message: errU
                  })
                });
              }
            }
          });
        }).then(function (response) {
          console.log("response", response);
          return new Promise(function (resolve, reject) {

            SNS.publish(params, function (err, data) {
              if (err) {
                reject({
                  statusCode: 400,
                  body: JSON.stringify({err})
                });
              }

              else {
                resolve({
                  statusCode: 200,
                  body: JSON.stringify({
                    cooldown: cooldown
                  })
                });
              }
            });
          })
        });
      }

      //insert
      else {
        var sqlInsert = 'insert into forgot_pass_codes (email, code, phone_number, efective_date, created_at, updated_at, deleted_at) VALUES ?';
        var values = [
          [
            emailWithoutInjection,
            recoveryCode.toString(),
            phonelWithoutInjection,
            effective_date,
            today,
            '',
            '',
          ]
        ];
        return new Promise(function (resolve, reject) {
          con.query(sqlInsert, [values], function async(errI, resultI) {

            //Error
            if (errI) {
              reject({
                statusCode: 400,
                body: JSON.stringify({
                  error: "Error al insertar registro",
                  message: errI
                })
              });
            }

            //Exito
            else {
              if (resultI.affectedRows > 0) {
                resolve({
                  statusCode: 201,
                  body: JSON.stringify({
                    id: recoveryCode,
                    cooldown: cooldown,
                  })
                });
              }

              else {
                reject({
                  statusCode: 400,
                  body: JSON.stringify({
                    error: "Error al insertar registro",
                  })
                });
              }
            }
          });
        }).then(function (response) {
          console.log("response", response);
          return new Promise(function (resolve, reject) {
            SNS.publish(params, function (err, data) {
              if (err) {
                reject({
                  statusCode: 400,
                  body: JSON.stringify({err})
                });
              }

              else {
                resolve({
                  statusCode: response.statusCode,
                  body: JSON.stringify({
                    cooldown: cooldown
                  })
                });
              }
            });
          });
        });
      }
    }).catch(function (error) {
      console.log("error promesa", error);
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Error desconocido",
          error: error.message
        })
      };
    })
  }

  catch (error) {
    console.log("error catch", error);
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "Error desconocido",
        error: error.message
      })
    };
  }
};

function parseParameterFromSSM(){
  return getParameterFromStoreAsync(process.env.SSM_PATH)
  .then(function (response) {
    const resultMap = {};
    const params = response.Parameters;
    for(let i = 0; i < params.length; i++) {
      let param = params[i];
      var name =param.Name.replace(process.env.SSM_PATH, "");
      resultMap[name] = param.Value;
    }
    return resultMap;
  }).catch(function (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "Error desconocido",
        error: error.message
      })
    };
  })  
};

function getParameterFromStoreAsync(path){
  var param = {
    Path: path,
    WithDecryption: true
  };
  return new Promise((resolve, reject) => {
      SSM.getParametersByPath(param, (err, data) => {
          if(err){
              reject(console.log('Error getting parameter: ' + err, err.stack));
          }
          return resolve(data);
      });
  });
};